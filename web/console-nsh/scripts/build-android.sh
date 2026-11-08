#!/usr/bin/env bash
# Builds the phone app: the console as an Android app (APK, or an App Bundle for Google Play).
# The app is a client of a `morph console serve` elsewhere, whose address the user enters on the
# login page (lib/mobileHost.ts). Needs nsh 0.4.0, Node and the Android SDK (build tools and
# `platforms;android-35`, found through ANDROID_HOME); no NDK, no Gradle.
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
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
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

# The console server is usually plain http:// on the local network, and Android refuses cleartext
# HTTP to apps that do not declare `android:usesCleartextTraffic` (nsh's Android runtime fetches
# through HttpURLConnection, which enforces it). `nsh package` declares it only for its development
# builds, so nsh runs here with an SDK whose aapt2 adds it to the manifest nsh links; everything
# else is the real SDK.
shim=$(mktemp -d)
trap 'rm -rf "$shim"' EXIT
mkdir -p "$shim/build-tools/$(basename "$build_tools")"
for entry in "$sdk"/*; do
  [[ "$(basename "$entry")" == build-tools ]] || ln -s "$entry" "$shim/$(basename "$entry")"
done
for entry in "$build_tools"/*; do
  [[ "$(basename "$entry")" == aapt2 ]] || ln -s "$entry" "$shim/build-tools/$(basename "$build_tools")/$(basename "$entry")"
done
cat >"$shim/build-tools/$(basename "$build_tools")/aapt2" <<EOF
#!/bin/sh
if [ "\$1" = link ]; then
  previous=""
  for arg in "\$@"; do
    if [ "\$previous" = "--manifest" ] && ! grep -q usesCleartextTraffic "\$arg"; then
      sed 's/<application /<application android:usesCleartextTraffic="true" /' "\$arg" >"\$arg.cleartext" && mv "\$arg.cleartext" "\$arg"
    fi
    previous="\$arg"
  done
fi
exec "$build_tools/aapt2" "\$@"
EOF
chmod +x "$shim/build-tools/$(basename "$build_tools")/aapt2"

node "$app/scripts/generate.mjs"
name=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).name)' "$app/nsh.json")
built="$app/.nsh/out/$name.$format"
rm -f "$built"
(cd "$app" && ANDROID_HOME="$shim" ANDROID_SDK_ROOT="$shim" nsh package App.tsx --target android ${args[@]+"${args[@]}"})

if [[ "$format" == apk ]] && ! "$build_tools/aapt2" dump xmltree --file AndroidManifest.xml "$built" | grep -q usesCleartextTraffic; then
  echo "the APK does not allow cleartext HTTP: did nsh stop linking its manifest with aapt2?" >&2
  exit 1
fi
mkdir -p "$(dirname "$out")"
cp "$built" "$out"
echo "phone app: $out"
