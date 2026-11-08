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

OUTPUT="$(default_backend_output)"
EMBED_FRONTEND=1
BUILD_FRONTEND=1
FRONTEND_CONFIG=""
CONSOLE="nsh"
USER_BUILD_TAGS=()

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
Usage: scripts/build-backend.sh [options]

Build the backend binary used by CLI and desktop packaging.

Options:
  --output PATH           Override backend binary output path
  --console nsh|vue       Which Console to embed (default: nsh, web/console-nsh;
                          vue is web/console)
  --frontend-config PATH  Build the Vue Console with a specific Vite config
  --tags TAGS             Add Go build tags
  --no-embed-frontend     Build backend without embedded Console SPA assets
  --skip-frontend-build   Reuse the Console's existing dist folder instead of rebuilding it
  -h, --help              Show this help

Notes:
  - Default behavior embeds the nsh Console (web/console-nsh) into the backend
    binary; building it needs nsh 0.4.0 and Node. --console vue embeds the Vue
    Console (web/console) and needs pnpm.
  - Default output path is ./bin/morph (or ./bin/morph.exe on Windows).
  - --frontend-config accepts an absolute path, a repo-root-relative path, or
    a path relative to web/console, for example: vite.config.js
  - --tags can be repeated. Values are passed to go build as one tag list.
  - --no-embed-frontend adds the Go build tag: noembedconsole
  - When embedding the frontend, this script stages the Console's dist folder
    (web/console-nsh/dist or web/console/dist) into
    cmd/mistermorph/consolecmd/static before go build.
  - CGO defaults to disabled for this backend build; override with CGO_ENABLED=1
    if you intentionally need a cgo-enabled backend binary.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    --console)
      case "${2:-}" in
        nsh|vue) CONSOLE="$2" ;;
        *)
          echo "--console must be nsh or vue." >&2
          exit 1
          ;;
      esac
      shift 2
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
    --no-embed-frontend)
      EMBED_FRONTEND=0
      shift
      ;;
    --skip-frontend-build)
      BUILD_FRONTEND=0
      shift
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

if [[ -z "${OUTPUT}" ]]; then
  echo "Output path cannot be empty." >&2
  exit 1
fi

if [[ "${CONSOLE}" == "nsh" && -n "${FRONTEND_CONFIG}" ]]; then
  echo "--frontend-config is a Vite config: it only applies with --console vue." >&2
  exit 1
fi

FRONTEND_CONFIG_PATH=""
if [[ "${EMBED_FRONTEND}" == "1" && "${BUILD_FRONTEND}" == "1" && -n "${FRONTEND_CONFIG}" ]]; then
  FRONTEND_CONFIG_PATH="$(resolve_frontend_config "${FRONTEND_CONFIG}")"
  if [[ ! -f "${FRONTEND_CONFIG_PATH}" ]]; then
    echo "Frontend config not found: ${FRONTEND_CONFIG}" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "${OUTPUT}")"

build_tags=()
if [[ ${#USER_BUILD_TAGS[@]} -gt 0 ]]; then
  build_tags=("${USER_BUILD_TAGS[@]}")
fi
if [[ "${EMBED_FRONTEND}" == "1" ]]; then
  if [[ "${CONSOLE}" == "nsh" ]]; then
    CONSOLE_DIST="${ROOT_DIR}/web/console-nsh/dist"
    if [[ "${BUILD_FRONTEND}" == "1" ]]; then
      echo "==> Building web/console-nsh"
      ./web/console-nsh/scripts/build-web.sh "${CONSOLE_DIST}"
    fi
  else
    CONSOLE_DIST="${ROOT_DIR}/web/console/dist"
    if [[ "${BUILD_FRONTEND}" == "1" ]]; then
      echo "==> Building web/console"
      if [[ -n "${FRONTEND_CONFIG_PATH}" ]]; then
        pnpm --dir web/console exec vite build --config "${FRONTEND_CONFIG_PATH}"
      else
        pnpm --dir web/console build
      fi
    fi
  fi

  echo "==> Staging console assets"
  ./scripts/stage-console-assets.sh "${CONSOLE_DIST}"
else
  build_tags+=(noembedconsole)
fi

echo "==> Building backend ${OUTPUT}"
if [[ ${#build_tags[@]} -gt 0 ]]; then
  echo "    tags: ${build_tags[*]}"
  CGO_ENABLED="${CGO_ENABLED:-0}" go build -tags "${build_tags[*]}" -o "${OUTPUT}" ./cmd/mistermorph
else
  CGO_ENABLED="${CGO_ENABLED:-0}" go build -o "${OUTPUT}" ./cmd/mistermorph
fi

echo
echo "Built backend: ${OUTPUT}"
if [[ "${EMBED_FRONTEND}" == "1" ]]; then
  echo "Console frontend: embedded (${CONSOLE})"
else
  echo "Console frontend: external (--console-static-dir required for SPA serving)"
fi
