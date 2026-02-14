#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

usage() {
  cat >&2 <<'USAGE'
Usage:
  ./run-local.sh /absolute/or/relative/path/to/config.yaml

Notes:
  - Source your env first (for example: source ./env.sh).
  - Required env: MISTER_MORPH_LLM_API_KEY
  - For telegram mode: MISTER_MORPH_TELEGRAM_BOT_TOKEN
USAGE
}

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

to_abs_path() {
  local input="$1"
  local dir base
  dir="$(cd "$(dirname "${input}")" && pwd)"
  base="$(basename "${input}")"
  echo "${dir}/${base}"
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

require_cmd docker

CONFIG_PATH="$(to_abs_path "$1")"
if [[ ! -f "${CONFIG_PATH}" ]]; then
  echo "Config file not found: ${CONFIG_PATH}" >&2
  exit 1
fi

RUN_MODE="${MISTER_MORPH_RUN_MODE:-telegram}"
LOG_LEVEL="${MISTER_MORPH_LOG_LEVEL:-debug}"
IMAGE_TAG="${MISTER_MORPH_LOCAL_IMAGE_TAG:-mistermorph-local:dev}"
CONTAINER_NAME="${MISTER_MORPH_LOCAL_CONTAINER_NAME:-mistermorph-local}"
SKIP_BUILD="${MISTER_MORPH_SKIP_BUILD:-0}"

if [[ -z "${MISTER_MORPH_LLM_API_KEY:-}" ]]; then
  echo "MISTER_MORPH_LLM_API_KEY is required." >&2
  exit 1
fi

if [[ "${RUN_MODE}" == "telegram" && -z "${MISTER_MORPH_TELEGRAM_BOT_TOKEN:-}" ]]; then
  echo "MISTER_MORPH_TELEGRAM_BOT_TOKEN is required when MISTER_MORPH_RUN_MODE=telegram." >&2
  exit 1
fi

STAGED_CONFIG_PATH="${SCRIPT_DIR}/config.runtime.yaml"

cleanup() {
  rm -f "${STAGED_CONFIG_PATH}"
}
trap cleanup EXIT

cp "${CONFIG_PATH}" "${STAGED_CONFIG_PATH}"
echo "Using config file: ${CONFIG_PATH}"
echo "Run mode: ${RUN_MODE}"

if [[ "${SKIP_BUILD}" != "1" ]]; then
  echo "Building image: ${IMAGE_TAG}"
  docker build -f "${SCRIPT_DIR}/Dockerfile" -t "${IMAGE_TAG}" "${REPO_ROOT}"
fi

run_env=(
  -e "MISTER_MORPH_RUN_MODE=${RUN_MODE}"
  -e "MISTER_MORPH_LOG_LEVEL=${LOG_LEVEL}"
  -e "MISTER_MORPH_LLM_API_KEY=${MISTER_MORPH_LLM_API_KEY}"
  -e "MISTER_MORPH_CONFIG_FILE=/run/config.yaml"
)

add_env_if_set() {
  local name="$1"
  local value="${!name:-}"
  if [[ -n "${value}" ]]; then
    run_env+=(-e "${name}=${value}")
  fi
}

add_env_if_set "MISTER_MORPH_TELEGRAM_BOT_TOKEN"
add_env_if_set "MISTER_MORPH_SERVER_AUTH_TOKEN"
add_env_if_set "MISTER_MORPH_LLM_PROVIDER"
add_env_if_set "MISTER_MORPH_LLM_ENDPOINT"
add_env_if_set "MISTER_MORPH_LLM_MODEL"
add_env_if_set "MISTER_MORPH_TOOLS_BASH_ENABLED"

echo "Starting container: ${CONTAINER_NAME}"
docker run --rm -it \
  --name "${CONTAINER_NAME}" \
  -v "${CONFIG_PATH}:/run/config.yaml:ro" \
  "${run_env[@]}" \
  "${IMAGE_TAG}"
