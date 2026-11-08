#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

target_goos() {
  if [[ -n "${GOOS:-}" ]]; then
    printf '%s\n' "${GOOS}"
    return
  fi
  go env GOOS
}

target_goarch() {
  if [[ -n "${GOARCH:-}" ]]; then
    printf '%s\n' "${GOARCH}"
    return
  fi
  go env GOARCH
}

default_desktop_output() {
  case "$(target_goos)" in
    windows)
      printf '%s\n' "./bin/MrMorph.exe"
      ;;
    *)
      printf '%s\n' "./bin/MrMorph"
      ;;
  esac
}

default_backend_output() {
  case "$(target_goos)" in
    windows)
      printf '%s\n' "./bin/morph.exe"
      ;;
    *)
      printf '%s\n' "./bin/morph"
      ;;
  esac
}

DESKTOP_OUTPUT="$(default_desktop_output)"
BACKEND_OUTPUT="$(default_backend_output)"
BUILD_FRONTEND=1
BUILD_BACKEND=1
RELEASE=0
USER_BUILD_TAGS=()

usage() {
  cat <<'EOF'
Usage: scripts/build-desktop.sh [options]

Build the desktop app and its local backend: the GPUI shell in desktop/nsh, which
draws web/console-nsh itself, and a backend with the nsh Console embedded. It needs
Rust, nsh 0.4.0, Node and Go (see desktop/nsh/README.md), and builds for this
machine only.

Options:
  --release           Build an optimized shell (default: a debug build)
  --tags TAGS         Add Go build tags for the backend
  --no-frontend       Reuse web/console-nsh/dist for the backend (the shell still
                      builds web/console-nsh into itself)
  --no-backend        Skip `go build` for ./cmd/mistermorph
  --desktop-output P  Override desktop binary output path
  --backend-output P  Override backend binary output path
  -h, --help          Show this help

Default outputs:
  desktop: ./bin/MrMorph (or ./bin/MrMorph.exe on Windows)
  backend: ./bin/morph (or ./bin/morph.exe on Windows)

Notes:
  - --tags can be repeated. Values are passed to go build as one tag list.
    The tag pro also builds the shell for the pro release channel.
  - The shell finds the backend next to itself, then in ./bin; keep both
    outputs in one folder to run it from anywhere.
  - Packaging (DMG, AppImage, deb) is in desktop/nsh/packaging.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      RELEASE=1
      shift
      ;;
    --tags)
      if [[ -z "${2:-}" ]]; then
        echo "--tags requires a value." >&2
        exit 1
      fi
      USER_BUILD_TAGS+=("${2:-}")
      shift 2
      ;;
    --no-frontend)
      BUILD_FRONTEND=0
      shift
      ;;
    --no-backend)
      BUILD_BACKEND=0
      shift
      ;;
    --desktop-output)
      DESKTOP_OUTPUT="${2:-}"
      shift 2
      ;;
    --backend-output)
      BACKEND_OUTPUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "${DESKTOP_OUTPUT}" || -z "${BACKEND_OUTPUT}" ]]; then
  echo "Output paths cannot be empty." >&2
  exit 1
fi

if [[ "$(target_goos)" != "$(go env GOHOSTOS)" || "$(target_goarch)" != "$(go env GOHOSTARCH)" ]]; then
  echo "The desktop app builds for this machine only; unset GOOS/GOARCH." >&2
  exit 1
fi

mkdir -p "$(dirname "${DESKTOP_OUTPUT}")" "$(dirname "${BACKEND_OUTPUT}")"

if [[ "${BUILD_BACKEND}" == "1" ]]; then
  backend_args=(--output "${BACKEND_OUTPUT}")
  if [[ "${BUILD_FRONTEND}" == "0" ]]; then
    backend_args+=(--skip-frontend-build)
  fi
  if [[ ${#USER_BUILD_TAGS[@]} -gt 0 ]]; then
    for tag_set in "${USER_BUILD_TAGS[@]}"; do
      backend_args+=(--tags "${tag_set}")
    done
  fi
  ./scripts/build-backend.sh "${backend_args[@]}"
fi

shell_args=(--skip-backend --output-dir "$(dirname "${DESKTOP_OUTPUT}")")
if [[ "${RELEASE}" == "0" ]]; then
  shell_args+=(--debug)
fi
if [[ ${#USER_BUILD_TAGS[@]} -gt 0 && " ${USER_BUILD_TAGS[*]} " == *" pro "* ]]; then
  shell_args+=(--pro)
fi
./desktop/nsh/build.sh "${shell_args[@]}"

# desktop/nsh/build.sh names the shell MrMorph in the folder it is given.
built_shell="$(dirname "${DESKTOP_OUTPUT}")/$(basename "$(default_desktop_output)")"
if [[ "${built_shell}" != "${DESKTOP_OUTPUT}" ]]; then
  mv "${built_shell}" "${DESKTOP_OUTPUT}"
fi

echo
echo "Built:"
echo "  backend: ${BACKEND_OUTPUT}"
echo "  desktop: ${DESKTOP_OUTPUT}"
