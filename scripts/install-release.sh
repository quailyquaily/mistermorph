#!/usr/bin/env bash
set -euo pipefail

# CHANNEL picks the release channel: community (default) or pro.
CHANNEL="${CHANNEL:-community}"
DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL:-https://downloads.mistermorph.com}"
DOWNLOAD_BASE_URL="${DOWNLOAD_BASE_URL%/}"
VERSION="${1:-${VERSION:-}}"
INSTALL_DIR="${INSTALL_DIR:-}"

case "${CHANNEL}" in
  community|pro) ;;
  *)
    echo "Unsupported CHANNEL: ${CHANNEL} (supported: community, pro)"
    exit 1
    ;;
esac

if [[ $# -ge 2 ]]; then
  INSTALL_DIR="$2"
fi

resolve_latest_version_tag() {
  local index tag
  index="$(curl -fsSL "${DOWNLOAD_BASE_URL}/${CHANNEL}/releases/index.json")" || return 1
  tag="$(printf '%s' "${index}" | tr -d '\n' | sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  if [[ -z "${tag}" ]]; then
    return 1
  fi
  printf '%s\n' "${tag}"
}

if [[ -z "${VERSION}" || "${VERSION}" == "latest" ]]; then
  echo "No version provided, resolving latest ${CHANNEL} release tag..."
  VERSION="$(resolve_latest_version_tag)" || {
    echo "Failed to resolve latest release tag."
    echo "Usage: $0 [version-tag] [install-dir]"
    echo "Example: $0"
    echo "Example: $0 v0.1.0"
    echo "Example: INSTALL_DIR=\$HOME/.local/bin $0"
    echo "Example: CHANNEL=pro $0"
    exit 1
  }
  echo "Resolved latest tag: ${VERSION}"
fi

VERSION_TAG="${VERSION}"
if [[ "${VERSION_TAG}" != v* ]]; then
  VERSION_TAG="v${VERSION_TAG}"
fi
ASSET_VERSION="${VERSION_TAG#v}"

OS="$(uname -s)"
case "${OS}" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows" ;;
  *)
    echo "Unsupported OS: ${OS} (supported: Linux, Darwin, Windows via Git Bash/MSYS2/Cygwin)"
    exit 1
    ;;
esac

if [[ -z "${INSTALL_DIR}" ]]; then
  if [[ "${OS}" == "windows" ]]; then
    INSTALL_DIR="${HOME}/.local/bin"
  else
    INSTALL_DIR="/usr/local/bin"
  fi
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *)
    echo "Unsupported architecture: ${ARCH} (supported: amd64, arm64)"
    exit 1
    ;;
esac

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

ARCHIVE_EXT="tar.gz"
BIN_NAME="morph"
if [[ "${OS}" == "windows" ]]; then
  ARCHIVE_EXT="zip"
  BIN_NAME="morph.exe"
fi

ASSET_NAME="morph_${ASSET_VERSION}_${OS}_${ARCH}.${ARCHIVE_EXT}"
RELEASE_URL="${DOWNLOAD_BASE_URL}/${CHANNEL}/releases/${VERSION_TAG}"
ARCHIVE="${TMP_DIR}/${ASSET_NAME}"
URL="${RELEASE_URL}/${ASSET_NAME}"

echo "Downloading ${URL}"
curl -fL "${URL}" -o "${ARCHIVE}"

if command -v sha256sum >/dev/null 2>&1; then
  SHA256_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
  SHA256_CMD=(shasum -a 256)
else
  SHA256_CMD=()
fi
if (( ${#SHA256_CMD[@]} > 0 )); then
  curl -fsSL "${RELEASE_URL}/checksums.txt" -o "${TMP_DIR}/checksums.txt"
  EXPECTED="$(awk -v name="${ASSET_NAME}" '$2 == name || $2 == "*" name { print $1 }' "${TMP_DIR}/checksums.txt")"
  ACTUAL="$("${SHA256_CMD[@]}" "${ARCHIVE}" | awk '{ print $1 }')"
  if [[ -z "${EXPECTED}" || "${EXPECTED}" != "${ACTUAL}" ]]; then
    echo "Install failed: checksum mismatch for ${ASSET_NAME}"
    exit 1
  fi
  echo "Checksum verified."
else
  echo "Warning: sha256sum/shasum not found; skipping checksum verification."
fi
if [[ "${ARCHIVE_EXT}" == "zip" ]]; then
  if command -v unzip >/dev/null 2>&1; then
    unzip -q "${ARCHIVE}" -d "${TMP_DIR}"
  else
    echo "Install failed: unzip is required to extract ${ARCHIVE}"
    exit 1
  fi
else
  tar -xzf "${ARCHIVE}" -C "${TMP_DIR}"
fi

BIN_SRC="${TMP_DIR}/${BIN_NAME}"
if [[ ! -f "${BIN_SRC}" ]]; then
  echo "Install failed: binary ${BIN_NAME} not found in archive"
  exit 1
fi

mkdir -p "${INSTALL_DIR}"
DEST_BIN="${INSTALL_DIR}/${BIN_NAME}"
if [[ "${OS}" == "windows" ]]; then
  if [[ ! -w "${INSTALL_DIR}" ]]; then
    echo "Install failed: ${INSTALL_DIR} is not writable. Set INSTALL_DIR to a writable path."
    exit 1
  fi
  cp -f "${BIN_SRC}" "${DEST_BIN}"
elif [[ -w "${INSTALL_DIR}" ]]; then
  install -m 0755 "${BIN_SRC}" "${DEST_BIN}"
else
  echo "Need elevated permission to write ${INSTALL_DIR}; using sudo"
  sudo install -m 0755 "${BIN_SRC}" "${DEST_BIN}"
fi

echo "Installed to ${DEST_BIN}"
"${DEST_BIN}" version
