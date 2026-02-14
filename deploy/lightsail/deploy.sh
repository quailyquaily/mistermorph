#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
cd "${SCRIPT_DIR}"

STAGED_CONFIG_PATH="${SCRIPT_DIR}/config.runtime.yaml"
DEPLOYMENT_PATH=""

if [[ -f "${SCRIPT_DIR}/env.sh" ]]; then
  # shellcheck disable=SC1091
  source "${SCRIPT_DIR}/env.sh"
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_PROFILE="${AWS_PROFILE:-}"
export AWS_PAGER=""
LIGHTSAIL_SERVICE_NAME="${LIGHTSAIL_SERVICE_NAME:-mistermorph}"
LIGHTSAIL_POWER="${LIGHTSAIL_POWER:-micro}"
LIGHTSAIL_SCALE="${LIGHTSAIL_SCALE:-1}"
LIGHTSAIL_CONTAINER_NAME="${LIGHTSAIL_CONTAINER_NAME:-mistermorph}"
LIGHTSAIL_IMAGE_LABEL="${LIGHTSAIL_IMAGE_LABEL:-mistermorph}"
LIGHTSAIL_CONTAINER_PORT="${LIGHTSAIL_CONTAINER_PORT:-8787}"
LIGHTSAIL_HEALTH_PATH="${LIGHTSAIL_HEALTH_PATH:-/health}"

MISTER_MORPH_CONFIG_PATH="${MISTER_MORPH_CONFIG_PATH:-${REPO_ROOT}/config.yaml}"
MISTER_MORPH_RUN_MODE="${MISTER_MORPH_RUN_MODE:-telegram}"
MISTER_MORPH_FILE_STATE_DIR="${MISTER_MORPH_FILE_STATE_DIR:-/tmp/mistermorph/state}"
MISTER_MORPH_FILE_CACHE_DIR="${MISTER_MORPH_FILE_CACHE_DIR:-/tmp/mistermorph/cache}"
MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL="${MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL:-1}"
MISTER_MORPH_TELEGRAM_HEALTH_ENABLED="${MISTER_MORPH_TELEGRAM_HEALTH_ENABLED:-true}"
MISTER_MORPH_TELEGRAM_HEALTH_BIND="${MISTER_MORPH_TELEGRAM_HEALTH_BIND:-0.0.0.0}"
MISTER_MORPH_TELEGRAM_HEALTH_PORT="${MISTER_MORPH_TELEGRAM_HEALTH_PORT:-${LIGHTSAIL_CONTAINER_PORT}}"
MISTER_MORPH_S3_STATE_BUCKET="${MISTER_MORPH_S3_STATE_BUCKET:-}"
MISTER_MORPH_S3_STATE_PREFIX="${MISTER_MORPH_S3_STATE_PREFIX:-default}"
MISTER_MORPH_S3_STATE_REGION="${MISTER_MORPH_S3_STATE_REGION:-${AWS_REGION}}"
MISTER_MORPH_S3_SYNC_INTERVAL="${MISTER_MORPH_S3_SYNC_INTERVAL:-30}"
MISTER_MORPH_S3_SYNC_DELETE="${MISTER_MORPH_S3_SYNC_DELETE:-1}"

if [[ -z "${LIGHTSAIL_LOCAL_IMAGE:-}" ]]; then
  LIGHTSAIL_LOCAL_IMAGE="mistermorph-lightsail:$(date +%Y%m%d%H%M%S)"
fi

cleanup() {
  rm -f "${STAGED_CONFIG_PATH}"
  if [[ -n "${DEPLOYMENT_PATH}" ]]; then
    rm -f "${DEPLOYMENT_PATH}"
  fi
}
trap cleanup EXIT

require_cmd() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Missing required command: ${cmd}" >&2
    exit 1
  fi
}

require_nonempty() {
  local key="$1"
  local value="$2"
  if [[ -z "${value}" ]]; then
    echo "${key} is required." >&2
    exit 1
  fi
}

require_cmd aws
require_cmd docker
require_cmd jq
require_cmd mktemp

DEPLOYMENT_PATH="$(mktemp /tmp/mistermorph-lightsail-deployment.XXXXXX.json)"
chmod 600 "${DEPLOYMENT_PATH}"

aws_cli() {
  if [[ -n "${AWS_PROFILE}" ]]; then
    aws --no-cli-pager --profile "${AWS_PROFILE}" "$@"
  else
    aws --no-cli-pager "$@"
  fi
}

require_json() {
  local label="$1"
  local payload="$2"
  if ! jq -e . >/dev/null 2>&1 <<<"${payload}"; then
    echo "${label} did not return valid JSON:" >&2
    printf '%s\n' "${payload}" >&2
    exit 1
  fi
}

resolve_remote_image() {
  local push_json="$1"
  local image_ref images_json

  image_ref="$(
    jq -r '
      [.image, .containerImage?.image, .containerImage, (.operations[]?.resourceName | select(type == "string" and startswith(":")))]
      | map(select(type == "string" and . != ""))
      | .[0] // empty
    ' <<<"${push_json}"
  )"
  if [[ -n "${image_ref}" ]]; then
    printf '%s\n' "${image_ref}"
    return 0
  fi

  images_json="$(aws_cli lightsail get-container-images --region "${AWS_REGION}" --service-name "${LIGHTSAIL_SERVICE_NAME}" --output json)"
  image_ref="$(
    jq -r --arg label "${LIGHTSAIL_IMAGE_LABEL}" '
      [.containerImages[]? | select((.image // "") | contains("." + $label + "."))]
      | sort_by(.createdAt)
      | last
      | .image // empty
    ' <<<"${images_json}"
  )"
  if [[ -n "${image_ref}" ]]; then
    printf '%s\n' "${image_ref}"
    return 0
  fi

  return 1
}

if ! [[ "${LIGHTSAIL_CONTAINER_PORT}" =~ ^[0-9]+$ ]]; then
  echo "LIGHTSAIL_CONTAINER_PORT must be numeric, got: ${LIGHTSAIL_CONTAINER_PORT}" >&2
  exit 1
fi
if ! [[ "${MISTER_MORPH_TELEGRAM_HEALTH_PORT}" =~ ^[0-9]+$ ]]; then
  echo "MISTER_MORPH_TELEGRAM_HEALTH_PORT must be numeric, got: ${MISTER_MORPH_TELEGRAM_HEALTH_PORT}" >&2
  exit 1
fi

if [[ ! -f "${MISTER_MORPH_CONFIG_PATH}" ]]; then
  echo "Config file not found: ${MISTER_MORPH_CONFIG_PATH}" >&2
  exit 1
fi

require_nonempty "MISTER_MORPH_LLM_API_KEY" "${MISTER_MORPH_LLM_API_KEY:-}"
require_nonempty "MISTER_MORPH_TELEGRAM_BOT_TOKEN" "${MISTER_MORPH_TELEGRAM_BOT_TOKEN:-}"

if ! aws_cli sts get-caller-identity --region "${AWS_REGION}" >/dev/null 2>&1; then
  echo "AWS credentials are not configured or invalid for region ${AWS_REGION}." >&2
  if [[ -n "${AWS_PROFILE}" ]]; then
    echo "Run: aws sso login --profile ${AWS_PROFILE}   (or configure static creds), then retry." >&2
  else
    echo "Run: aws configure sso   (or aws configure) and retry." >&2
  fi
  exit 1
fi

cp "${MISTER_MORPH_CONFIG_PATH}" "${STAGED_CONFIG_PATH}"
echo "Using config file: ${MISTER_MORPH_CONFIG_PATH}"

echo "Building image (${LIGHTSAIL_LOCAL_IMAGE}) for linux/amd64..."
docker build \
  --platform linux/amd64 \
  -f "${SCRIPT_DIR}/Dockerfile" \
  -t "${LIGHTSAIL_LOCAL_IMAGE}" \
  "${REPO_ROOT}"

services_json="$(
  aws_cli lightsail get-container-services --region "${AWS_REGION}" --output json
)"
require_json "aws lightsail get-container-services" "${services_json}"
service_exists="$(
  jq -r --arg name "${LIGHTSAIL_SERVICE_NAME}" '[.containerServices[]? | select(.containerServiceName == $name)] | length' <<<"${services_json}"
)"

if [[ "${service_exists}" == "0" ]]; then
  echo "Creating Lightsail container service: ${LIGHTSAIL_SERVICE_NAME} (${LIGHTSAIL_POWER} x ${LIGHTSAIL_SCALE})"
  aws_cli lightsail create-container-service \
    --region "${AWS_REGION}" \
    --service-name "${LIGHTSAIL_SERVICE_NAME}" \
    --power "${LIGHTSAIL_POWER}" \
    --scale "${LIGHTSAIL_SCALE}" >/dev/null
else
  echo "Using existing Lightsail service: ${LIGHTSAIL_SERVICE_NAME}"
fi

echo "Pushing local image to Lightsail..."
if ! push_output="$(
  aws_cli lightsail push-container-image \
    --region "${AWS_REGION}" \
    --service-name "${LIGHTSAIL_SERVICE_NAME}" \
    --label "${LIGHTSAIL_IMAGE_LABEL}" \
    --image "${LIGHTSAIL_LOCAL_IMAGE}" \
    --output json 2>&1
)"; then
  printf '%s\n' "${push_output}" >&2
  exit 1
fi
require_json "aws lightsail push-container-image" "${push_output}"
printf '%s\n' "${push_output}"

remote_image="$(resolve_remote_image "${push_output}" || true)"

if [[ -z "${remote_image}" ]]; then
  echo "Failed to resolve pushed Lightsail image reference." >&2
  printf '%s\n' "${push_output}" >&2
  exit 1
fi
echo "Using remote image: ${remote_image}"

env_json="$(jq -n \
  --arg llm_api_key "${MISTER_MORPH_LLM_API_KEY}" \
  --arg telegram_bot_token "${MISTER_MORPH_TELEGRAM_BOT_TOKEN}" \
  --arg run_mode "${MISTER_MORPH_RUN_MODE}" \
  --arg file_state_dir "${MISTER_MORPH_FILE_STATE_DIR}" \
  --arg file_cache_dir "${MISTER_MORPH_FILE_CACHE_DIR}" \
  --arg skip_bootstrap "${MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL}" \
  --arg tg_health_enabled "${MISTER_MORPH_TELEGRAM_HEALTH_ENABLED}" \
  --arg tg_health_bind "${MISTER_MORPH_TELEGRAM_HEALTH_BIND}" \
  --arg tg_health_port "${MISTER_MORPH_TELEGRAM_HEALTH_PORT}" \
  '{
    MISTER_MORPH_LLM_API_KEY: $llm_api_key,
    MISTER_MORPH_TELEGRAM_BOT_TOKEN: $telegram_bot_token,
    MISTER_MORPH_RUN_MODE: $run_mode,
    MISTER_MORPH_FILE_STATE_DIR: $file_state_dir,
    MISTER_MORPH_FILE_CACHE_DIR: $file_cache_dir,
    MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL: $skip_bootstrap,
    MISTER_MORPH_TELEGRAM_HEALTH_ENABLED: $tg_health_enabled,
    MISTER_MORPH_TELEGRAM_HEALTH_BIND: $tg_health_bind,
    MISTER_MORPH_TELEGRAM_HEALTH_PORT: $tg_health_port
  }'
)"

add_optional_env() {
  local key="$1"
  local value="${!key:-}"
  if [[ -n "${value}" ]]; then
    env_json="$(jq --arg k "${key}" --arg v "${value}" '. + {($k): $v}' <<<"${env_json}")"
  fi
}

OPTIONAL_ENV_KEYS=(
  MISTER_MORPH_LLM_PROVIDER
  MISTER_MORPH_LLM_ENDPOINT
  MISTER_MORPH_LLM_MODEL
  MISTER_MORPH_LOG_LEVEL
  MISTER_MORPH_TOOLS_BASH_ENABLED
  MISTER_MORPH_SERVER_AUTH_TOKEN
  MISTER_MORPH_S3_STATE_BUCKET
  MISTER_MORPH_S3_STATE_PREFIX
  MISTER_MORPH_S3_STATE_REGION
  MISTER_MORPH_S3_SYNC_INTERVAL
  MISTER_MORPH_S3_SYNC_DELETE
  AWS_REGION
)
for key in "${OPTIONAL_ENV_KEYS[@]}"; do
  add_optional_env "${key}"
done

jq -n \
  --arg container_name "${LIGHTSAIL_CONTAINER_NAME}" \
  --arg image "${remote_image}" \
  --arg port "${LIGHTSAIL_CONTAINER_PORT}" \
  --arg health_path "${LIGHTSAIL_HEALTH_PATH}" \
  --argjson container_port "${LIGHTSAIL_CONTAINER_PORT}" \
  --argjson env "${env_json}" \
  '{
    containers: {
      ($container_name): {
        image: $image,
        environment: $env,
        ports: {
          ($port): "HTTP"
        }
      }
    },
    publicEndpoint: {
      containerName: $container_name,
      containerPort: $container_port,
      healthCheck: {
        path: $health_path,
        successCodes: "200-399",
        intervalSeconds: 10,
        timeoutSeconds: 5,
        healthyThreshold: 2,
        unhealthyThreshold: 2
      }
    }
  }' >"${DEPLOYMENT_PATH}"

echo "Creating deployment..."
aws_cli lightsail create-container-service-deployment \
  --region "${AWS_REGION}" \
  --service-name "${LIGHTSAIL_SERVICE_NAME}" \
  --cli-input-json "file://${DEPLOYMENT_PATH}" >/dev/null

service_json="$(
  aws_cli lightsail get-container-services --region "${AWS_REGION}" --output json
)"
require_json "aws lightsail get-container-services" "${service_json}"
service_json="$(
  jq -r --arg name "${LIGHTSAIL_SERVICE_NAME}" '.containerServices[]? | select(.containerServiceName == $name)' <<<"${service_json}"
)"
if [[ -z "${service_json}" ]]; then
  service_json='{}'
fi

service_state="$(jq -r '.state // "unknown"' <<<"${service_json}")"
service_url="$(jq -r '.url // empty' <<<"${service_json}")"
service_power="$(jq -r '.power // empty' <<<"${service_json}")"
service_scale="$(jq -r '.scale // empty' <<<"${service_json}")"

echo
echo "Lightsail deployment submitted."
echo "Region:          ${AWS_REGION}"
echo "Service:         ${LIGHTSAIL_SERVICE_NAME}"
echo "Container:       ${LIGHTSAIL_CONTAINER_NAME}"
echo "Service state:   ${service_state}"
if [[ -n "${service_power}" || -n "${service_scale}" ]]; then
  echo "Service size:    ${service_power} x ${service_scale}"
fi
if [[ -n "${service_url}" ]]; then
  echo "Public endpoint: ${service_url}"
fi
echo
echo "Check service status:"
if [[ -n "${AWS_PROFILE}" ]]; then
  echo "aws --profile ${AWS_PROFILE} lightsail get-container-services --region ${AWS_REGION} --output json | jq '.containerServices[] | select(.containerServiceName == \"${LIGHTSAIL_SERVICE_NAME}\")'"
else
  echo "aws lightsail get-container-services --region ${AWS_REGION} --output json | jq '.containerServices[] | select(.containerServiceName == \"${LIGHTSAIL_SERVICE_NAME}\")'"
fi
echo
echo "Fetch container logs:"
if [[ -n "${AWS_PROFILE}" ]]; then
  echo "aws --profile ${AWS_PROFILE} lightsail get-container-log --region ${AWS_REGION} --service-name ${LIGHTSAIL_SERVICE_NAME} --container-name ${LIGHTSAIL_CONTAINER_NAME}"
else
  echo "aws lightsail get-container-log --region ${AWS_REGION} --service-name ${LIGHTSAIL_SERVICE_NAME} --container-name ${LIGHTSAIL_CONTAINER_NAME}"
fi
