#!/usr/bin/env bash
# Builds the desktop app: the backend (`morph`, pure Go, without the web console) and the GPUI
# shell (`MrMorph`) that embeds web/console-nsh, side by side in one folder.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

OUTPUT_DIR="./bin/desktop-nsh"
PROFILE="release"
BUILD_BACKEND=1
FEATURES=()

usage() {
  cat <<'EOF'
Usage: desktop/nsh/build.sh [options]

Options:
  --output-dir DIR   Where MrMorph and morph go (default ./bin/desktop-nsh)
  --debug            Build the shell without optimizations
  --skip-backend     Keep the morph already in the output folder
  --pro              Follow the pro release channel (backend tag and shell feature)
  -h, --help         Show this help

Environment:
  VERSION                       Desktop version (default: git describe, else "dev")
  NSH, NODE                     The nsh and node binaries the shell's build uses
  MISTERMORPH_DESKTOP_APP_DIR   Embed this `nsh build` output instead of building web/console-nsh
EOF
}

BACKEND_TAGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output-dir) OUTPUT_DIR="${2:?--output-dir needs a value}"; shift 2 ;;
    --debug) PROFILE="debug"; shift ;;
    --skip-backend) BUILD_BACKEND=0; shift ;;
    --pro) FEATURES=(--features pro); BACKEND_TAGS=(--tags pro); shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 1 ;;
  esac
done

desktop_version() {
  if [[ -n "${VERSION:-}" ]]; then
    printf '%s\n' "${VERSION#v}"
    return
  fi
  local described
  described="$(git describe --tags --always --dirty 2>/dev/null || true)"
  printf '%s\n' "${described:-dev}" | sed 's/^v//'
}

exe=""
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) exe=".exe" ;; esac

mkdir -p "${OUTPUT_DIR}"

if [[ "${BUILD_BACKEND}" == "1" ]]; then
  # The shell draws the console itself: the backend only serves the API.
  ./scripts/build-backend.sh --no-embed-frontend ${BACKEND_TAGS[@]+"${BACKEND_TAGS[@]}"} --output "${OUTPUT_DIR}/morph${exe}"
fi

echo "==> Building the desktop shell (${PROFILE})"
cargo_args=(build ${FEATURES[@]+"${FEATURES[@]}"})
if [[ "${PROFILE}" == "release" ]]; then
  cargo_args+=(--release)
fi
# From its own folder, so rustup picks the toolchain in rust-toolchain.toml.
version="$(desktop_version)"
(cd desktop/nsh && MISTERMORPH_DESKTOP_VERSION="${version}" cargo "${cargo_args[@]}")
cp "desktop/nsh/target/${PROFILE}/MrMorph${exe}" "${OUTPUT_DIR}/MrMorph${exe}"

echo
echo "Built ${OUTPUT_DIR}/MrMorph${exe} (version $(desktop_version)) and ${OUTPUT_DIR}/morph${exe}"
