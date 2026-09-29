#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WINDOWS_PACKAGING_DIR="${WINDOWS_PACKAGING_DIR:-${ROOT_DIR}/desktop/wails/packaging/windows}"
# The icon: 16 to 256 px, each size drawn for that size (design/brand/generator/platforms.py).
ICON_ICO="${ICON_ICO:-${ROOT_DIR}/desktop/wails/packaging/icons/windows/appicon.ico}"
MANIFEST_PATH="${MANIFEST_PATH:-${WINDOWS_PACKAGING_DIR}/wails.exe.manifest}"
ARCH="${ARCH:-amd64}"
SYSO_OUT="${SYSO_OUT:-${ROOT_DIR}/desktop/wails/rsrc_windows_${ARCH}.syso}"

if [[ ! -f "${ICON_ICO}" ]]; then
  echo "missing Windows icon: ${ICON_ICO}" >&2
  exit 1
fi

if [[ ! -f "${MANIFEST_PATH}" ]]; then
  echo "missing Windows manifest: ${MANIFEST_PATH}" >&2
  exit 1
fi

mkdir -p "${WINDOWS_PACKAGING_DIR}"
rm -f "${SYSO_OUT}"

wails_version="$(go list -m -f '{{.Version}}' github.com/wailsapp/wails/v3)"
if [[ -z "${wails_version}" ]]; then
  echo "failed to resolve github.com/wailsapp/wails/v3 version from go.mod" >&2
  exit 1
fi

echo "==> Generating Windows .syso for ${ARCH}"
go run "github.com/wailsapp/wails/v3/cmd/wails3@${wails_version}" generate syso \
  -arch "${ARCH}" \
  -icon "${ICON_ICO}" \
  -manifest "${MANIFEST_PATH}" \
  -out "${SYSO_OUT}"

echo
echo "Generated:"
echo "  icon: ${ICON_ICO}"
echo "  syso: ${SYSO_OUT}"
