#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
if [[ -f "${SCRIPT_DIR}/env.sh" ]]; then source "${SCRIPT_DIR}/env.sh"; fi
if [[ $# -gt 1 ]]; then
  echo "Usage: ./run-local.sh [config.yaml]" >&2
  exit 1
fi
if [[ -z "${MISTER_MORPH_CONSOLE_PASSWORD:-}${MISTER_MORPH_CONSOLE_PASSWORD_HASH:-}" ]]; then
  echo "Set MISTER_MORPH_CONSOLE_PASSWORD or MISTER_MORPH_CONSOLE_PASSWORD_HASH." >&2
  exit 1
fi
if [[ $# -eq 1 ]]; then
  MISTER_MORPH_CONFIG_YAML="$(cat "$1")"
  export MISTER_MORPH_CONFIG_YAML
fi
IMAGE_TAG="${MISTER_MORPH_LOCAL_IMAGE_TAG:-mistermorph-console:dev}"
CONTAINER_NAME="${MISTER_MORPH_LOCAL_CONTAINER_NAME:-mistermorph-console}"
STATE_VOLUME="${MISTER_MORPH_LOCAL_STATE_VOLUME:-mistermorph-console-state}"
if [[ "${MISTER_MORPH_SKIP_BUILD:-0}" != 1 ]]; then
  docker build --platform linux/amd64 -f "${SCRIPT_DIR}/Dockerfile" -t "${IMAGE_TAG}" "${REPO_ROOT}"
fi

# Local runs use a named Docker volume instead of touching the cloud R2 backup.
run_env=(-e MISTER_MORPH_ALLOW_EPHEMERAL_STATE=1)
for key in MISTER_MORPH_CONSOLE_PASSWORD MISTER_MORPH_CONSOLE_PASSWORD_HASH MISTER_MORPH_SERVER_AUTH_TOKEN MISTER_MORPH_CONFIG_YAML MISTER_MORPH_LLM_API_KEY MISTER_MORPH_LLM_INFERENCE_PROVIDER MISTER_MORPH_LLM_PROVIDER MISTER_MORPH_LLM_ENDPOINT MISTER_MORPH_LLM_MODEL MISTER_MORPH_LOG_LEVEL MISTER_MORPH_TOOLS_BASH_ENABLED; do
  if [[ -n "${!key:-}" ]]; then export "${key}"; run_env+=(-e "${key}"); fi
done
docker run --rm -it --platform linux/amd64 --name "${CONTAINER_NAME}" \
  -p 127.0.0.1:8787:8787 \
  --mount "type=volume,source=${STATE_VOLUME},target=/data/state" \
  "${run_env[@]}" "${IMAGE_TAG}"
