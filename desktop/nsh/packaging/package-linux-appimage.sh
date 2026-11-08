#!/usr/bin/env bash
# Packages the nsh desktop app (MrMorph, the GPUI shell) and the morph backend as an AppImage and
# the updater tarball (the AppDir). linuxdeploy bundles the shell's few shared libraries; the
# Vulkan loader and driver, which the shell opens at run time, come from the host system.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CALLER_DIR="$(pwd)"
APP_BINARY_NAME="${APP_BINARY_NAME:-MrMorph}"
DISPLAY_NAME="${DISPLAY_NAME:-MrMorph}"
APPLICATION_ID="${APPLICATION_ID:-com.mistermorph}"
# Named as the window's app id, so Wayland compositors match the window to this entry and its icon.
DESKTOP_FILE_ID="${DESKTOP_FILE_ID:-com.mistermorph}"
VERSION="${VERSION:-0.0.0}"
ARCH="${ARCH:-amd64}"
DESKTOP_BIN="${DESKTOP_BIN:-${ROOT_DIR}/dist/MrMorph}"
BACKEND_BIN="${BACKEND_BIN:-${ROOT_DIR}/dist/morph}"
BUNDLED_BACKEND_NAME="${BUNDLED_BACKEND_NAME:-morph}"
# The icon theme: every freedesktop size drawn for that size, plus a scalable SVG
# (design/brand/generator/platforms.py).
ICON_THEME_SOURCE="${ICON_THEME_SOURCE:-${ROOT_DIR}/desktop/nsh/packaging/icons/linux/hicolor}"
OUT_DIR="${OUT_DIR:-${ROOT_DIR}/dist}"
WORK_ROOT="${WORK_ROOT:-${OUT_DIR}/appimage-work}"
APPIMAGE_NAME="${APPIMAGE_NAME:-MrMorph-linux-${ARCH}.AppImage}"
TARBALL_PATH="${TARBALL_PATH:-${OUT_DIR}/MrMorph-linux-${ARCH}.tar.gz}"

abspath() {
  local path="$1"
  if [[ "${path}" == /* ]]; then
    printf '%s\n' "${path}"
    return
  fi
  printf '%s\n' "${CALLER_DIR}/${path}"
}

require_file() {
  local path="$1"
  if [[ ! -f "${path}" ]]; then
    echo "missing required file: ${path}" >&2
    exit 1
  fi
}

install_icon_theme() {
  local target="$1"
  local size_dir
  for size_dir in "${ICON_THEME_SOURCE}"/*; do
    [[ -d "${size_dir}/apps" ]] || continue
    local size_name
    size_name="$(basename "${size_dir}")"
    mkdir -p "${target}/${size_name}/apps"
    if [[ "${size_name}" == "scalable" ]]; then
      install -m 0644 "${size_dir}/apps/icon.svg" "${target}/${size_name}/apps/${APPLICATION_ID}.svg"
    else
      install -m 0644 "${size_dir}/apps/icon.png" "${target}/${size_name}/apps/${APPLICATION_ID}.png"
    fi
  done
}

for command_name in curl tar; do
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    echo "missing required command: ${command_name}" >&2
    exit 1
  fi
done

require_file "${DESKTOP_BIN}"
require_file "${BACKEND_BIN}"
require_file "${ICON_THEME_SOURCE}/256x256/apps/icon.png"

DESKTOP_BIN="$(abspath "${DESKTOP_BIN}")"
BACKEND_BIN="$(abspath "${BACKEND_BIN}")"
ICON_THEME_SOURCE="$(abspath "${ICON_THEME_SOURCE}")"
OUT_DIR="$(abspath "${OUT_DIR}")"
WORK_ROOT="$(abspath "${WORK_ROOT}")"
TOOLS_DIR="${WORK_ROOT}/tools"
BUILD_DIR="${WORK_ROOT}/build"

case "${ARCH}" in
  amd64)
    APPIMAGE_ARCH="x86_64"
    ;;
  arm64)
    APPIMAGE_ARCH="aarch64"
    ;;
  *)
    echo "unsupported architecture for AppImage: ${ARCH}" >&2
    exit 1
    ;;
esac

APPDIR="${BUILD_DIR}/${APP_BINARY_NAME}-${APPIMAGE_ARCH}.AppDir"
LINUXDEPLOY="${TOOLS_DIR}/linuxdeploy-${APPIMAGE_ARCH}.AppImage"
DESKTOP_FILE="${WORK_ROOT}/${DESKTOP_FILE_ID}.desktop"
OUTPUT_PATH="${OUT_DIR}/${APPIMAGE_NAME}"

rm -rf "${WORK_ROOT}" "${OUTPUT_PATH}" "${TARBALL_PATH}"
mkdir -p "${OUT_DIR}" "${TOOLS_DIR}" "${APPDIR}/usr/bin"

cp "${DESKTOP_BIN}" "${APPDIR}/usr/bin/${APP_BINARY_NAME}"
chmod +x "${APPDIR}/usr/bin/${APP_BINARY_NAME}"

install_icon_theme "${APPDIR}/usr/share/icons/hicolor"
cp "${ICON_THEME_SOURCE}/256x256/apps/icon.png" "${APPDIR}/.DirIcon"
ln -sf ".DirIcon" "${APPDIR}/${APPLICATION_ID}.png"

cat > "${DESKTOP_FILE}" <<EOF
[Desktop Entry]
Type=Application
Name=${DISPLAY_NAME}
Comment=MrMorph Desktop
Exec=${APP_BINARY_NAME}
Icon=${APPLICATION_ID}
Categories=Development;Utility;
Terminal=false
StartupWMClass=${APPLICATION_ID}
EOF
cp "${DESKTOP_FILE}" "${APPDIR}/"

curl -fsSL \
  "https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-${APPIMAGE_ARCH}.AppImage" \
  -o "${LINUXDEPLOY}"
chmod +x "${LINUXDEPLOY}"

pushd "${BUILD_DIR}" >/dev/null
# The shell's libraries first (AppRun becomes a link to it, from the desktop entry's Exec); the
# backend is a static Go binary and is copied in afterwards so linuxdeploy leaves it alone.
PATH="${TOOLS_DIR}:${PATH}" \
  "${LINUXDEPLOY}" --appimage-extract-and-run --appdir "${APPDIR}" \
    --executable "${APPDIR}/usr/bin/${APP_BINARY_NAME}" \
    --desktop-file "${APPDIR}/${DESKTOP_FILE_ID}.desktop"

cp "${BACKEND_BIN}" "${APPDIR}/usr/bin/${BUNDLED_BACKEND_NAME}"
chmod +x "${APPDIR}/usr/bin/${BUNDLED_BACKEND_NAME}"

PATH="${TOOLS_DIR}:${PATH}" \
  "${LINUXDEPLOY}" --appimage-extract-and-run --appdir "${APPDIR}" --output appimage
popd >/dev/null

shopt -s nullglob
generated_appimages=("${BUILD_DIR}"/*.AppImage)
shopt -u nullglob
if [[ "${#generated_appimages[@]}" -ne 1 ]]; then
  echo "expected exactly one generated AppImage in ${BUILD_DIR}, found ${#generated_appimages[@]}" >&2
  exit 1
fi

mv "${generated_appimages[0]}" "${OUTPUT_PATH}"
# The updater tarball should contain the runnable AppDir bundle itself,
# not an AppImage nested inside another archive.
tar -C "${BUILD_DIR}" -czf "${TARBALL_PATH}" "$(basename "${APPDIR}")"
