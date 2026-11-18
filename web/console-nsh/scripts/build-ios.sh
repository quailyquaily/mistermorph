#!/usr/bin/env bash
# Builds the iPhone app: the console as an iOS app signed for the App Store (Morph.ipa), a client of
# a `morph console serve` elsewhere like the Android app (scripts/build-android.sh). Needs macOS with
# Xcode, nsh 0.5.1 with its iOS runtime (`nsh component add ios`, added here when missing; it is not
# published for Linux), Node, an Apple Distribution identity in the keychain and an App Store
# provisioning profile for nsh.json's id. `xcrun altool --upload-app` uploads it to TestFlight.
#
#   scripts/build-ios.sh --sign IDENTITY --profile FILE [--out FILE]
#
# The app is named Morph on the home screen, as on Android (nsh.json's name is the web console's).
# Its icon is ios/AppIcon-1024.png (design/brand/generator/platforms.py). VERSION (0.3.80) sets the
# version and the build number (3080), as for Android; App Store Connect takes each build once.
set -euo pipefail

app=$(cd "$(dirname "$0")/.." && pwd)
name=Morph
out="$app/dist-ios/$name.ipa"
icon="$app/ios/AppIcon-1024.png"
sign=""
profile=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="${2:?--out needs a file}"; shift 2 ;;
    --sign) sign="${2:?--sign needs an identity}"; shift 2 ;;
    --profile) profile="${2:?--profile needs a .mobileprovision file}"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done
if [[ "$(uname -s)" != Darwin ]]; then
  echo "the iOS app builds on macOS only (nsh's iOS runtime and codesign); CI builds it on macos-15" >&2
  exit 1
fi
if [[ -z "$sign" || -z "$profile" ]]; then
  echo "--sign (an \"Apple Distribution: …\" identity) and --profile (an App Store .mobileprovision) are required" >&2
  exit 1
fi
[[ -f "$profile" ]] || { echo "no provisioning profile at $profile" >&2; exit 1; }
profile=$(cd "$(dirname "$profile")" && pwd)/$(basename "$profile")
if [[ -n "${VERSION:-}" ]]; then
  version="${VERSION#v}"
  args+=(--app-version "$version")
  # The build number grows with the version: major * 1000000 + minor * 1000 + patch (0.3.80 is 3080).
  if [[ "$version" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
    args+=(--build "$((BASH_REMATCH[1] * 1000000 + BASH_REMATCH[2] * 1000 + BASH_REMATCH[3]))")
  fi
fi

# The App Store refuses an app icon with an alpha channel.
if [[ "$(sips -g hasAlpha "$icon" | awk '/hasAlpha/ {print $2}')" != no ]]; then
  echo "$icon has an alpha channel, which the App Store refuses" >&2
  exit 1
fi

# nsh 0.5 ships the platforms' runtimes as components, added on demand.
if ! nsh component list | grep -qE '^ios[[:space:]]+installed'; then
  nsh component add ios
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
node "$app/scripts/generate.mjs"
(cd "$app" && nsh package App.tsx --target ios --name "$name" --icon "$icon" \
  --sign "$sign" --profile "$profile" --out "$work/out" ${args[@]+"${args[@]}"})

ipas=()
while IFS= read -r file; do ipas+=("$file"); done < <(find "$work/out" -maxdepth 2 -name '*.ipa')
if [[ ${#ipas[@]} -ne 1 ]]; then
  echo "expected one .ipa from nsh package, found ${#ipas[@]} in $work/out" >&2
  exit 1
fi
built="${ipas[0]}"

# What the home screen and the App Store read, from the signed app itself.
mkdir -p "$work/ipa"
unzip -q "$built" -d "$work/ipa"
bundle=$(find "$work/ipa/Payload" -maxdepth 1 -name '*.app' | head -1)
plist="$bundle/Info.plist"
read_plist() { plutil -extract "$1" raw -o - "$plist" 2>/dev/null || true; }
id=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).id)' "$app/nsh.json")
label=$(read_plist CFBundleDisplayName)
[[ -n "$label" ]] || label=$(read_plist CFBundleName)
if [[ "$label" != "$name" ]]; then
  echo "the app is labelled '$label', not $name: did nsh stop taking --name?" >&2
  exit 1
fi
if [[ "$(read_plist CFBundleIdentifier)" != "$id" ]]; then
  echo "the app's bundle id is '$(read_plist CFBundleIdentifier)', not $id" >&2
  exit 1
fi
codesign --verify --strict "$bundle"
# Not checked before on a device: the console server is usually plain http:// on the local network,
# which App Transport Security blocks unless the app allows it, and voice input needs the
# microphone's usage text (App Store Connect rejects an upload without it).
if [[ "$(read_plist NSAppTransportSecurity.NSAllowsArbitraryLoads)" != true &&
  "$(read_plist NSAppTransportSecurity.NSAllowsLocalNetworking)" != true ]]; then
  echo "warning: Info.plist allows no plain http:// (NSAppTransportSecurity): the app reaches only https:// servers" >&2
fi
if [[ -z "$(read_plist NSMicrophoneUsageDescription)" ]]; then
  echo "warning: Info.plist has no NSMicrophoneUsageDescription" >&2
fi

mkdir -p "$(dirname "$out")"
cp "$built" "$out"
echo "iPhone app: $out ($(read_plist CFBundleShortVersionString) build $(read_plist CFBundleVersion))"
