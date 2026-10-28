#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
APP_BUNDLE_NAME="${APP_BUNDLE_NAME:-MrMorph}"
APP_DISPLAY_NAME="${APP_DISPLAY_NAME:-MrMorph}"
APP_EXECUTABLE_NAME="${APP_EXECUTABLE_NAME:-MrMorph}"
BUNDLE_ID="${BUNDLE_ID:-com.mistermorph}"
VERSION="${VERSION:-0.0.0}"
ARCH="${ARCH:-arm64}"
DESKTOP_BIN="${DESKTOP_BIN:-${ROOT_DIR}/dist/MrMorph}"
BACKEND_BIN="${BACKEND_BIN:-${ROOT_DIR}/dist/morph}"
BUNDLED_BACKEND_NAME="${BUNDLED_BACKEND_NAME:-morph}"
# The iconset: every size drawn for that size, on the macOS icon grid (design/brand/generator/platforms.py).
ICONSET_SOURCE="${ICONSET_SOURCE:-${ROOT_DIR}/desktop/wails/packaging/icons/macos}"
DMG_BACKGROUND_SOURCE="${DMG_BACKGROUND_SOURCE:-${ROOT_DIR}/desktop/wails/packaging/dmg-background.png}"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/dist}"
APP_DIR="${OUT_DIR}/${APP_BUNDLE_NAME}.app"
DMG_PATH="${DMG_PATH:-${OUT_DIR}/MrMorph-darwin-${ARCH}.dmg}"
DMG_VOLUME_NAME="${DMG_VOLUME_NAME:-${APP_DISPLAY_NAME} Installer}"
TARBALL_PATH="${TARBALL_PATH:-${OUT_DIR}/MrMorph-darwin-${ARCH}.tar.gz}"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mistermorph-darwin-package.XXXXXX")"
ICONSET_DIR="${WORK_ROOT}/mistermorph.iconset"
DMG_STAGING_DIR="${WORK_ROOT}/dmg"
RW_DMG_PATH="${WORK_ROOT}/mistermorph-rw.dmg"
DMG_ATTACH_LOG="${WORK_ROOT}/attach.log"
ICNS_PATH="${OUT_DIR}/mistermorph.icns"
DMG_ATTACHED=false
DMG_DEVICE=""

cleanup() {
	if [[ "${DMG_ATTACHED}" == "true" ]]; then
		if [[ -z "${DMG_DEVICE}" ]] || ! hdiutil detach "${DMG_DEVICE}" -force; then
			echo "DMG is still attached; preserving staging files at ${WORK_ROOT}" >&2
			return
		fi
	fi
	rm -rf "${WORK_ROOT}"
}
trap cleanup EXIT

require_file() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    echo "missing required file: ${path}" >&2
    exit 1
  fi
}

for command_name in codesign ditto hdiutil iconutil osascript tar; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "missing required command: ${command_name}" >&2
    exit 1
  fi
done

require_file "${DESKTOP_BIN}"
require_file "${BACKEND_BIN}"
require_file "${DMG_BACKGROUND_SOURCE}"

mkdir -p "${OUT_DIR}" "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
rm -rf "${APP_DIR}" "${DMG_PATH}" "${TARBALL_PATH}" "${ICNS_PATH}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"
mkdir -p "${ICONSET_DIR}" "${DMG_STAGING_DIR}/.background"

for icon_name in icon_16x16.png icon_16x16@2x.png icon_32x32.png icon_32x32@2x.png icon_128x128.png \
  icon_128x128@2x.png icon_256x256.png icon_256x256@2x.png icon_512x512.png icon_512x512@2x.png; do
  require_file "${ICONSET_SOURCE}/${icon_name}"
  cp "${ICONSET_SOURCE}/${icon_name}" "${ICONSET_DIR}/${icon_name}"
done
iconutil -c icns "${ICONSET_DIR}" -o "${ICNS_PATH}"

cp "${ICNS_PATH}" "${APP_DIR}/Contents/Resources/mistermorph.icns"
cp "${DESKTOP_BIN}" "${APP_DIR}/Contents/MacOS/${APP_EXECUTABLE_NAME}"
cp "${BACKEND_BIN}" "${APP_DIR}/Contents/MacOS/${BUNDLED_BACKEND_NAME}"
chmod +x "${APP_DIR}/Contents/MacOS/${APP_EXECUTABLE_NAME}" "${APP_DIR}/Contents/MacOS/${BUNDLED_BACKEND_NAME}"

cat > "${APP_DIR}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_DISPLAY_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>${APP_EXECUTABLE_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>mistermorph.icns</string>
  <key>CFBundleIdentifier</key>
  <string>${BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${APP_DISPLAY_NAME}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>10.15</string>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
EOF

CODESIGN_IDENTITY="${CODESIGN_IDENTITY:-}"
# Notarization uses an App Store Connect API key (scripts/macos-notarize.sh).
APPLE_API_KEY_PATH="${APPLE_API_KEY_PATH:-}"
APPLE_API_KEY_ID="${APPLE_API_KEY_ID:-}"
APPLE_API_ISSUER_ID="${APPLE_API_ISSUER_ID:-}"
NOTARIZE=false
if [[ -n "${CODESIGN_IDENTITY}" && -n "${APPLE_API_KEY_PATH}" && -n "${APPLE_API_KEY_ID}" && -n "${APPLE_API_ISSUER_ID}" ]]; then
  NOTARIZE=true
fi

if [[ -n "${CODESIGN_IDENTITY}" ]]; then
  echo "signing with identity: ${CODESIGN_IDENTITY}"
  codesign --force --options runtime \
    --sign "${CODESIGN_IDENTITY}" \
    --timestamp \
    "${APP_DIR}/Contents/MacOS/${BUNDLED_BACKEND_NAME}"
  codesign --force --options runtime \
    --sign "${CODESIGN_IDENTITY}" \
    --timestamp \
    "${APP_DIR}/Contents/MacOS/${APP_EXECUTABLE_NAME}"
  codesign --force --options runtime \
    --sign "${CODESIGN_IDENTITY}" \
    --timestamp \
    "${APP_DIR}"
else
  echo "no CODESIGN_IDENTITY set; applying ad-hoc signature for test distribution"
  codesign --force --sign - "${APP_DIR}/Contents/MacOS/${BUNDLED_BACKEND_NAME}"
  codesign --force --sign - "${APP_DIR}/Contents/MacOS/${APP_EXECUTABLE_NAME}"
  codesign --force --sign - "${APP_DIR}"
fi

echo "verifying app bundle signature..."
codesign --verify --deep --strict --verbose=2 "${APP_DIR}"

if [[ -n "${CODESIGN_IDENTITY}" && "${NOTARIZE}" != "true" ]]; then
  echo "skipping notarization because the App Store Connect API key settings are incomplete"
fi

ditto "${APP_DIR}" "${DMG_STAGING_DIR}/${APP_BUNDLE_NAME}.app"
ln -s "/Applications" "${DMG_STAGING_DIR}/Applications"
cp "${DMG_BACKGROUND_SOURCE}" "${DMG_STAGING_DIR}/.background/background.png"

# hdiutil create sometimes fails with "Resource busy" on CI runners; it passes on a retry.
for attempt in 1 2 3 4 5; do
	if hdiutil create \
		-volname "${DMG_VOLUME_NAME}" \
		-srcfolder "${DMG_STAGING_DIR}" \
		-ov \
		-format UDRW \
		"${RW_DMG_PATH}" >/dev/null; then
		break
	fi
	if (( attempt == 5 )); then
		echo "hdiutil create failed after ${attempt} attempts" >&2
		exit 1
	fi
	echo "hdiutil create failed (attempt ${attempt}); retrying in $(( attempt * 5 ))s..." >&2
	sleep $(( attempt * 5 ))
done

hdiutil attach \
	-readwrite \
	-noverify \
	-noautoopen \
	"${RW_DMG_PATH}" >"${DMG_ATTACH_LOG}"
DMG_ATTACHED=true
# hdiutil's tab-separated output includes the image device before its partitions.
# Detach that device rather than guessing a mount path from the volume name.
cat "${DMG_ATTACH_LOG}"
DMG_DEVICE="$(awk '/^\/dev\/disk/ { print $1; exit }' "${DMG_ATTACH_LOG}")"
if [[ -z "${DMG_DEVICE}" ]]; then
	echo "failed to identify attached DMG device" >&2
	exit 1
fi

osascript - "${DMG_VOLUME_NAME}" "${APP_BUNDLE_NAME}.app" <<'APPLESCRIPT'
on run arguments
	set volumeName to item 1 of arguments
	set appItemName to item 2 of arguments
	set finderReady to false
	repeat 20 times
		tell application "Finder"
			if exists disk volumeName then
				set finderReady to true
				exit repeat
			end if
		end tell
		delay 0.5
	end repeat
	if not finderReady then error "Finder did not register disk " & volumeName
	tell application "Finder"
		set targetDisk to disk volumeName
		tell targetDisk
			open
			set current view of container window to icon view
			set toolbar visible of container window to false
			set statusbar visible of container window to false
			set bounds of container window to {100, 100, 860, 608}
			set viewOptions to icon view options of container window
			set arrangement of viewOptions to not arranged
			set icon size of viewOptions to 128
			set text size of viewOptions to 14
			set label position of viewOptions to bottom
			set background picture of viewOptions to file ".background:background.png"
			set position of item appItemName to {200, 245}
			set position of item "Applications" to {560, 245}
			update without registering applications
			delay 2
			close container window
		end tell
	end tell
end run
APPLESCRIPT

sync
for attempt in 1 2 3 4 5; do
	echo "detaching DMG device ${DMG_DEVICE} (attempt ${attempt}/5)..."
	if hdiutil detach "${DMG_DEVICE}"; then
		DMG_ATTACHED=false
		break
	fi
	if [[ "${attempt}" -lt 5 ]]; then
		sleep "$((attempt * 2))"
	fi
done
if [[ "${DMG_ATTACHED}" == "true" ]]; then
	# All packaging writes are complete and synced. Finder or an indexer may
	# still hold files open on this disposable staging volume.
	echo "normal detach failed; forcing detach of ${DMG_DEVICE}..." >&2
	if hdiutil detach "${DMG_DEVICE}" -force; then
		DMG_ATTACHED=false
	fi
fi
if [[ "${DMG_ATTACHED}" == "true" ]]; then
	echo "failed to detach DMG staging volume (${DMG_DEVICE})" >&2
	exit 1
fi

hdiutil convert \
	"${RW_DMG_PATH}" \
	-format UDZO \
	-imagekey zlib-level=9 \
	-o "${DMG_PATH}" >/dev/null

if [[ -n "${CODESIGN_IDENTITY}" ]]; then
  echo "signing DMG..."
  codesign --force \
    --sign "${CODESIGN_IDENTITY}" \
    --timestamp \
    "${DMG_PATH}"
  codesign --verify --verbose=2 "${DMG_PATH}"
fi

if [[ "${NOTARIZE}" == "true" ]]; then
  "${ROOT_DIR}/scripts/macos-notarize.sh" "${DMG_PATH}"
  echo "stapling notarization ticket..."
  xcrun stapler staple "${DMG_PATH}"
  xcrun stapler validate "${DMG_PATH}"
  xcrun stapler staple "${APP_DIR}"
  xcrun stapler validate "${APP_DIR}"
fi

tar -C "${OUT_DIR}" -czf "${TARBALL_PATH}" "${APP_BUNDLE_NAME}.app"
