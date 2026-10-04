#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 0 ]]; then
  echo "Usage: ./deploy.sh (set WRANGLER_ENV and WRANGLER_CONFIG_PATH in the environment)." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}"

# env.sh is local executable configuration; never include it in the image.
if [[ -f ./env.sh ]]; then
  source ./env.sh
fi

WRANGLER_ENV="${WRANGLER_ENV:-}"
WRANGLER_CONFIG_PATH="${WRANGLER_CONFIG_PATH:-${SCRIPT_DIR}/wrangler.jsonc}"

MISTER_MORPH_CONSOLE_PASSWORD="${MISTER_MORPH_CONSOLE_PASSWORD:-}"
MISTER_MORPH_CONSOLE_PASSWORD_HASH="${MISTER_MORPH_CONSOLE_PASSWORD_HASH:-}"
MISTER_MORPH_SERVER_AUTH_TOKEN="${MISTER_MORPH_SERVER_AUTH_TOKEN:-}"

if [[ -z "${MISTER_MORPH_CONSOLE_PASSWORD//[[:space:]]/}" && -z "${MISTER_MORPH_CONSOLE_PASSWORD_HASH//[[:space:]]/}" ]]; then
  echo "Set MISTER_MORPH_CONSOLE_PASSWORD or MISTER_MORPH_CONSOLE_PASSWORD_HASH." >&2
  exit 1
fi
if [[ -z "${MISTER_MORPH_SERVER_AUTH_TOKEN//[[:space:]]/}" ]]; then
  echo "Set a stable MISTER_MORPH_SERVER_AUTH_TOKEN for container administration." >&2
  exit 1
fi
if [[ -n "${MISTER_MORPH_CONFIG_PATH:-}" && ! -f "${MISTER_MORPH_CONFIG_PATH}" ]]; then
  echo "MISTER_MORPH_CONFIG_PATH must name an existing YAML file." >&2
  exit 1
fi
if [[ -n "${MISTER_MORPH_CONFIG_PATH:-}" && "$(wc -c < "${MISTER_MORPH_CONFIG_PATH}")" -gt 5120 ]]; then
  echo "The config seed exceeds the 5120-byte Worker secret limit; use a minimal YAML seed." >&2
  exit 1
fi
if [[ "${MISTER_MORPH_ALLOW_EPHEMERAL_STATE:-0}" != "1" ]]; then
  for key in MISTER_MORPH_R2_ACCOUNT_ID MISTER_MORPH_R2_BUCKET MISTER_MORPH_R2_PREFIX MISTER_MORPH_R2_ACCESS_KEY_ID MISTER_MORPH_R2_SECRET_ACCESS_KEY; do
    if [[ -z "${!key:-}" ]]; then
      echo "Missing ${key}; configure R2 backup or explicitly allow ephemeral state." >&2
      exit 1
    fi
    export "${key}"
  done
fi

for command in node npm npx docker; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "Missing required command: ${command}" >&2
    exit 1
  fi
done
if [[ "${SKIP_NPM_INSTALL:-0}" != "1" ]]; then
  npm ci
fi

WRANGLER=(npx --no-install wrangler --config "${WRANGLER_CONFIG_PATH}")
ENV_FLAGS=()
if [[ -n "${WRANGLER_ENV}" ]]; then
  ENV_FLAGS+=(--env "${WRANGLER_ENV}")
fi
"${WRANGLER[@]}" whoami >/dev/null

# Always send both password fields so changing from a hash to plaintext (or back)
# cannot leave an old credential taking precedence. Do not print secret values.
export MISTER_MORPH_CONSOLE_PASSWORD MISTER_MORPH_CONSOLE_PASSWORD_HASH MISTER_MORPH_SERVER_AUTH_TOKEN
export MISTER_MORPH_CONFIG_PATH
export MISTER_MORPH_ALLOW_EPHEMERAL_STATE MISTER_MORPH_R2_BACKUP_INTERVAL
node --input-type=module <<'JS' | "${WRANGLER[@]}" secret bulk "${ENV_FLAGS[@]}"
import fs from "node:fs";
const secrets = {
  MISTER_MORPH_CONSOLE_PASSWORD: process.env.MISTER_MORPH_CONSOLE_PASSWORD || "",
  MISTER_MORPH_CONSOLE_PASSWORD_HASH: process.env.MISTER_MORPH_CONSOLE_PASSWORD_HASH || "",
  MISTER_MORPH_SERVER_AUTH_TOKEN: process.env.MISTER_MORPH_SERVER_AUTH_TOKEN,
  MISTER_MORPH_ALLOW_EPHEMERAL_STATE: process.env.MISTER_MORPH_ALLOW_EPHEMERAL_STATE || "0",
  MISTER_MORPH_R2_BACKUP_INTERVAL: process.env.MISTER_MORPH_R2_BACKUP_INTERVAL || "60",
};
for (const key of ["MISTER_MORPH_R2_ACCOUNT_ID", "MISTER_MORPH_R2_BUCKET", "MISTER_MORPH_R2_PREFIX", "MISTER_MORPH_R2_ACCESS_KEY_ID", "MISTER_MORPH_R2_SECRET_ACCESS_KEY"]) {
  if (process.env[key]) secrets[key] = process.env[key];
}
if (process.env.MISTER_MORPH_LLM_API_KEY) secrets.MISTER_MORPH_LLM_API_KEY = process.env.MISTER_MORPH_LLM_API_KEY;
if (process.env.MISTER_MORPH_CONFIG_PATH) {
  secrets.MISTER_MORPH_CONFIG_YAML = fs.readFileSync(process.env.MISTER_MORPH_CONFIG_PATH, "utf8");
}
process.stdout.write(JSON.stringify(secrets));
JS

VAR_FLAGS=()
for key in MISTER_MORPH_LLM_INFERENCE_PROVIDER MISTER_MORPH_LLM_PROVIDER MISTER_MORPH_LLM_ENDPOINT MISTER_MORPH_LLM_MODEL MISTER_MORPH_LOG_LEVEL MISTER_MORPH_TOOLS_BASH_ENABLED; do
  if [[ -n "${!key:-}" ]]; then VAR_FLAGS+=(--var "${key}:${!key}"); fi
done
"${WRANGLER[@]}" deploy "${ENV_FLAGS[@]}" "${VAR_FLAGS[@]}"
echo "Console deployed. Open the Worker URL and sign in with the Console password."
