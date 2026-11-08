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

desktop_build_version() {
  if [[ -n "${VERSION:-}" ]]; then
    printf '%s\n' "${VERSION#v}"
    return
  fi
  if command -v git >/dev/null 2>&1; then
    local described
    described="$(git describe --tags --always --dirty 2>/dev/null || true)"
    if [[ -n "${described}" ]]; then
      printf '%s\n' "${described#v}"
      return
    fi
  fi
  printf '%s\n' "dev"
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
ENABLE_DEVTOOLS=1
HOST_OS="$(uname -s)"
FRONTEND_CONFIG=""
USER_BUILD_TAGS=()
DESKTOP_SHELL="nsh"

resolve_frontend_config() {
  local config="$1"
  if [[ "${config}" == /* ]]; then
    printf '%s\n' "${config}"
    return
  fi
  if [[ -f "${ROOT_DIR}/${config}" ]]; then
    printf '%s\n' "${ROOT_DIR}/${config}"
    return
  fi
  printf '%s\n' "${ROOT_DIR}/web/console/${config}"
}

usage() {
  cat <<'EOF'
Usage: scripts/build-desktop.sh [options]

Build the desktop app and its local backend.

By default this builds the nsh desktop app: the GPUI shell in desktop/nsh, which
draws web/console-nsh itself, and a backend with the nsh Console embedded. It needs
Rust, nsh 0.4.0, Node and Go (see desktop/nsh/README.md). --wails builds the
previous Wails app (desktop/wails) with the Vue Console instead.

Options:
  --wails             Build the Wails app with the Vue Console (web/console)
  --release           Build desktop app without devtools (nsh: an optimized shell;
                      without it the shell is a debug build)
  --frontend-config P Build the Vue Console with a specific Vite config (--wails only)
  --tags TAGS         Add Go build tags for backend and desktop builds
  --no-frontend       Reuse the Console's existing dist folder for the backend
                      (nsh: the shell still builds web/console-nsh into itself)
  --no-backend        Skip `go build` for ./cmd/mistermorph
  --desktop-output P  Override desktop binary output path
  --backend-output P  Override backend binary output path
  -h, --help          Show this help

Default desktop build tags (--wails):
  Linux debug build:  wailsdesktop dev devtools
  Other debug build:  wailsdesktop production devtools
  Release build:      wailsdesktop production

Default outputs:
  desktop: ./bin/MrMorph (or ./bin/MrMorph.exe on Windows)
  backend: ./bin/morph (or ./bin/morph.exe on Windows)

Notes:
  - --frontend-config accepts an absolute path, a repo-root-relative path, or
    a path relative to web/console, for example: vite.config.pro.js
  - --tags can be repeated. Values are passed to go build as one tag list.
    With the nsh shell, the tag pro also builds the shell for the pro channel.
  - Windows builds embed desktop/wails/packaging/icons/windows/appicon.ico.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --wails)
      DESKTOP_SHELL="wails"
      shift
      ;;
    --release)
      ENABLE_DEVTOOLS=0
      shift
      ;;
    --frontend-config)
      if [[ -z "${2:-}" ]]; then
        echo "--frontend-config requires a value." >&2
        exit 1
      fi
      FRONTEND_CONFIG="${2:-}"
      shift 2
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

if [[ "${DESKTOP_SHELL}" == "nsh" ]]; then
  if [[ -n "${FRONTEND_CONFIG}" ]]; then
    echo "--frontend-config is a Vite config for the Vue Console: use it with --wails." >&2
    exit 1
  fi
  if [[ "$(target_goos)" != "$(go env GOHOSTOS)" || "$(target_goarch)" != "$(go env GOHOSTARCH)" ]]; then
    echo "The nsh desktop app builds for this machine only; unset GOOS/GOARCH (or use --wails)." >&2
    exit 1
  fi

  mkdir -p "$(dirname "${DESKTOP_OUTPUT}")" "$(dirname "${BACKEND_OUTPUT}")"

  shell_args=(--skip-backend --output-dir "$(dirname "${DESKTOP_OUTPUT}")")
  if [[ "${ENABLE_DEVTOOLS}" == "1" ]]; then
    shell_args+=(--debug)
  fi

  if [[ "${BUILD_BACKEND}" == "1" ]]; then
    backend_args=(--console nsh --output "${BACKEND_OUTPUT}")
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
  echo "  backend: ${BACKEND_OUTPUT} (nsh Console embedded)"
  echo "  desktop: ${DESKTOP_OUTPUT} (nsh shell)"
  exit 0
fi

FRONTEND_CONFIG_PATH=""
if [[ "${BUILD_FRONTEND}" == "1" && -n "${FRONTEND_CONFIG}" ]]; then
  FRONTEND_CONFIG_PATH="$(resolve_frontend_config "${FRONTEND_CONFIG}")"
  if [[ ! -f "${FRONTEND_CONFIG_PATH}" ]]; then
    echo "Frontend config not found: ${FRONTEND_CONFIG}" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "${DESKTOP_OUTPUT}")" "$(dirname "${BACKEND_OUTPUT}")"

if [[ "${BUILD_FRONTEND}" == "1" ]]; then
  echo "==> Building web/console"
  if [[ -n "${FRONTEND_CONFIG_PATH}" ]]; then
    pnpm --dir web/console exec vite build --config "${FRONTEND_CONFIG_PATH}"
  else
    pnpm --dir web/console build
  fi
fi

if [[ "${BUILD_BACKEND}" == "1" ]]; then
  echo "==> Building backend ${BACKEND_OUTPUT}"
  backend_args=(--console vue --skip-frontend-build --output "${BACKEND_OUTPUT}")
  if [[ ${#USER_BUILD_TAGS[@]} -gt 0 ]]; then
    for tag_set in "${USER_BUILD_TAGS[@]}"; do
      backend_args+=(--tags "${tag_set}")
    done
  fi
  ./scripts/build-backend.sh "${backend_args[@]}"
fi

desktop_tags=(wailsdesktop)
if [[ "${ENABLE_DEVTOOLS}" == "1" ]]; then
  if [[ "${HOST_OS}" == "Linux" ]]; then
    # Wails v3 alpha currently has no linux+production+devtools implementation.
    desktop_tags+=(dev devtools)
  else
    desktop_tags+=(production devtools)
  fi
else
  desktop_tags+=(production)
fi
if [[ ${#USER_BUILD_TAGS[@]} -gt 0 ]]; then
  desktop_tags+=("${USER_BUILD_TAGS[@]}")
fi

echo "==> Building desktop ${DESKTOP_OUTPUT}"
echo "    tags: ${desktop_tags[*]}"
desktop_ldflags_value="-X main.desktopVersion=$(desktop_build_version)"
if [[ "$(target_goos)" == "windows" ]]; then
  echo "==> Generating Windows icon resources"
  ARCH="$(target_goarch)" ./scripts/generate-desktop-windows-resources.sh
  desktop_ldflags_value="-H=windowsgui ${desktop_ldflags_value}"
fi
go build -ldflags "${desktop_ldflags_value}" -tags "${desktop_tags[*]}" -o "${DESKTOP_OUTPUT}" ./desktop/wails

echo
echo "Built:"
echo "  backend: ${BACKEND_OUTPUT}"
echo "  desktop: ${DESKTOP_OUTPUT}"
if [[ "${ENABLE_DEVTOOLS}" == "1" ]]; then
  echo "  inspector: Ctrl+Shift+F12"
fi
