#!/usr/bin/env bash
set -euo pipefail

REPO="${REPO:-quailyquaily/mistermorph}"
VERSION="${1:-${VERSION:-}}"
INSTALL_DIR="${INSTALL_DIR:-/usr/local/bin}"

if [[ -z "${VERSION}" ]]; then
  echo "Usage: $0 <version-tag> [install-dir]"
  echo "Example: $0 v0.1.0"
  echo "Example: INSTALL_DIR=\$HOME/.local/bin $0 v0.1.0"
  exit 1
fi

if [[ $# -ge 2 ]]; then
  INSTALL_DIR="$2"
fi

OS="$(uname -s)"
case "${OS}" in
  Linux) OS="linux" ;;
  Darwin) OS="darwin" ;;
  *)
    echo "Unsupported OS: ${OS} (supported: Linux, Darwin)"
    exit 1
    ;;
esac

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

ARCHIVE="${TMP_DIR}/mistermorph.tar.gz"
URL="https://github.com/${REPO}/releases/download/${VERSION}/mistermorph_${VERSION}_${OS}_${ARCH}.tar.gz"

echo "Downloading ${URL}"
curl -fL "${URL}" -o "${ARCHIVE}"
tar -xzf "${ARCHIVE}" -C "${TMP_DIR}"

BIN_SRC="${TMP_DIR}/mistermorph"
if [[ ! -f "${BIN_SRC}" ]]; then
  echo "Install failed: binary not found in archive"
  exit 1
fi

mkdir -p "${INSTALL_DIR}"
if [[ -w "${INSTALL_DIR}" ]]; then
  install -m 0755 "${BIN_SRC}" "${INSTALL_DIR}/mistermorph"
else
  echo "Need elevated permission to write ${INSTALL_DIR}; using sudo"
  sudo install -m 0755 "${BIN_SRC}" "${INSTALL_DIR}/mistermorph"
fi

echo "Installed to ${INSTALL_DIR}/mistermorph"
"${INSTALL_DIR}/mistermorph" version
