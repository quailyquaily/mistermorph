#!/usr/bin/env bash
# Builds the phone app: the console as an Android app (APK, or an App Bundle for Google Play).
# The app is a client of a `morph console serve` elsewhere, whose address the user enters on the
# login page (lib/mobileHost.ts). Needs the nsh 0.4.0 distribution (its Android runtime and
# embed/android/nsh.aar), Node, a JDK and the Android SDK (build tools and `platforms;android-35`,
# found through ANDROID_HOME); no NDK, no Gradle. The app's own Java (android/src: voice input's
# recorder) goes into the runtime's classes.dex (scripts/android-host.sh).
#
#   scripts/build-android.sh [--out FILE] [--abi ABI]... [--format apk|aab] [--run]
#                            [--keystore FILE --key-alias ALIAS]   (password: NSH_KEYSTORE_PASSWORD)
#
# Without --keystore the APK is signed with the debug key. VERSION (0.3.80) sets the version name
# and the version code (3080).
set -euo pipefail

app=$(cd "$(dirname "$0")/.." && pwd)
out="$app/dist-android/MrMorph.apk"
format=apk
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="${2:?--out needs a file}"; shift 2 ;;
    --abi) args+=(--abi "${2:?--abi needs a value}"); shift 2 ;;
    --format) format="${2:?--format needs apk or aab}"; args+=(--format "$format"); shift 2 ;;
    --run) args+=(--run); shift ;;
    --keystore) args+=(--keystore "${2:?--keystore needs a file}"); shift 2 ;;
    --key-alias) args+=(--key-alias "${2:?--key-alias needs a value}"); shift 2 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ -n "${VERSION:-}" ]]; then
  version="${VERSION#v}"
  args+=(--app-version "$version")
  # Android installs an update only over a lower or equal version code: one from the version,
  # major * 1000000 + minor * 1000 + patch (0.3.80 is 3080).
  if [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    args+=(--build "$((BASH_REMATCH[1] * 1000000 + BASH_REMATCH[2] * 1000 + BASH_REMATCH[3]))")
  fi
fi

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [[ -z "$sdk" ]]; then
  for candidate in "$HOME/Android/Sdk" "$HOME/Library/Android/sdk"; do
    [[ -d "$candidate" ]] && sdk="$candidate" && break
  done
fi
if [[ -z "$sdk" || ! -d "$sdk/build-tools" ]]; then
  echo "Android SDK not found: set ANDROID_HOME" >&2
  exit 1
fi
build_tools=$(ls -d "$sdk"/build-tools/*/ | sort -V | tail -1)
build_tools=${build_tools%/}

# The prebuilt Android runtime nsh packages (classes.dex and lib/<abi>/libnsh.so), and nsh.aar, whose
# classes the app's Java compiles against.
nsh_bin=$(command -v nsh) || { echo "nsh not found" >&2; exit 1; }
nsh_root=$(cd "$(dirname "$(readlink -f "$nsh_bin")")/.." && pwd)
runtime="${NSH_RUNTIME:-$nsh_root/runtime}/android/release"
aar="$nsh_root/embed/android/nsh.aar"
if [[ ! -f "$runtime/classes.dex" || ! -f "$aar" ]]; then
  echo "no Android runtime or embed/android/nsh.aar in the nsh at $nsh_root: put the nsh distribution's bin/nsh first on PATH" >&2
  exit 1
fi

shim=$(mktemp -d)
trap 'rm -rf "$shim"' EXIT

# nsh packages the runtime's classes.dex as it is, so it runs with a copy of the runtime
# (NSH_RUNTIME) whose classes.dex also holds the app's Java; the native libraries are the runtime's.
mkdir -p "$shim/nsh-runtime/android/release"
ln -s "$runtime/lib" "$shim/nsh-runtime/android/release/lib"
"$app/scripts/android-host.sh" dex "$runtime/classes.dex" "$aar" "$sdk/platforms/android-35/android.jar" \
  "$build_tools" "$shim/nsh-runtime/android/release"

# The manifest nsh links lacks what the app adds (scripts/android-manifest.mjs): cleartext HTTP (the
# console server is usually plain http:// on the local network, nsh's Android runtime fetches through
# HttpURLConnection, which enforces it, and `nsh package` declares it only for its development
# builds), and voice input's permission, Application and permission activity. So nsh runs with an
# SDK whose aapt2 patches the manifest before linking it; everything else is the real SDK.
tools="$shim/sdk/build-tools/$(basename "$build_tools")"
mkdir -p "$tools"
for entry in "$sdk"/*; do
  [[ "$(basename "$entry")" == build-tools ]] || ln -s "$entry" "$shim/sdk/$(basename "$entry")"
done
for entry in "$build_tools"/*; do
  [[ "$(basename "$entry")" == aapt2 ]] || ln -s "$entry" "$tools/$(basename "$entry")"
done
cat >"$tools/aapt2" <<EOF
#!/bin/sh
if [ "\$1" = link ]; then
  previous=""
  for arg in "\$@"; do
    if [ "\$previous" = "--manifest" ]; then
      node "$app/scripts/android-manifest.mjs" "\$arg" || exit 1
    fi
    previous="\$arg"
  done
fi
exec "$build_tools/aapt2" "\$@"
EOF
chmod +x "$tools/aapt2"

node "$app/scripts/generate.mjs"
name=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$app/nsh.json")
built="$app/.nsh/out/$name.$format"
rm -f "$built"
(cd "$app" && ANDROID_HOME="$shim/sdk" ANDROID_SDK_ROOT="$shim/sdk" NSH_RUNTIME="$shim/nsh-runtime" \
  nsh package App.tsx --target android ${args[@]+"${args[@]}"})

if [[ "$format" == apk ]]; then
  manifest=$("$build_tools/aapt2" dump xmltree --file AndroidManifest.xml "$built")
  for wanted in usesCleartextTraffic android.permission.RECORD_AUDIO \
    com.mistermorph.console.MorphApplication com.mistermorph.console.VoicePermissionActivity; do
    if ! grep -q "$wanted" <<<"$manifest"; then
      echo "the APK's manifest lacks $wanted: did nsh stop linking its manifest with aapt2?" >&2
      exit 1
    fi
  done
  classes=$("$build_tools/dexdump" "$built" 2>/dev/null | grep "Class descriptor")
  if ! grep -q "Lcom/mistermorph/console/MorphApplication;" <<<"$classes"; then
    echo "the APK's classes.dex lacks the app's Java: did nsh stop packaging NSH_RUNTIME's classes.dex?" >&2
    exit 1
  fi
fi
mkdir -p "$(dirname "$out")"
cp "$built" "$out"
echo "phone app: $out"
