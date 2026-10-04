#!/usr/bin/env bash
# Copy to env.sh. deploy.sh and run-local.sh load it before applying defaults.
# Keep this file private. Existing shell values take precedence over these defaults.
export CLOUDFLARE_ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
export CLOUDFLARE_API_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
export WRANGLER_ENV="${WRANGLER_ENV:-prod}"

# Required: Console login and a separate, stable administration token.
# A bcrypt hash can replace the plaintext password. Quote hashes with single quotes.
export MISTER_MORPH_CONSOLE_PASSWORD="${MISTER_MORPH_CONSOLE_PASSWORD:-}"
export MISTER_MORPH_CONSOLE_PASSWORD_HASH="${MISTER_MORPH_CONSOLE_PASSWORD_HASH:-}"
export MISTER_MORPH_SERVER_AUTH_TOKEN="${MISTER_MORPH_SERVER_AUTH_TOKEN:-}"

# R2 S3 credentials scoped to one private bucket with Object Read & Write access.
# Use a different prefix for every deployment/environment. Never share a prefix
# between running Consoles. Wrangler credentials above are not R2 credentials.
export MISTER_MORPH_R2_ACCOUNT_ID="${MISTER_MORPH_R2_ACCOUNT_ID:-${CLOUDFLARE_ACCOUNT_ID}}"
export MISTER_MORPH_R2_BUCKET="${MISTER_MORPH_R2_BUCKET:-}"
export MISTER_MORPH_R2_PREFIX="${MISTER_MORPH_R2_PREFIX:-console-prod}"
export MISTER_MORPH_R2_ACCESS_KEY_ID="${MISTER_MORPH_R2_ACCESS_KEY_ID:-}"
export MISTER_MORPH_R2_SECRET_ACCESS_KEY="${MISTER_MORPH_R2_SECRET_ACCESS_KEY:-}"
export MISTER_MORPH_R2_BACKUP_INTERVAL="${MISTER_MORPH_R2_BACKUP_INTERVAL:-60}"
# Testing only: 1 bypasses R2 and accepts data loss when a cloud container stops.
export MISTER_MORPH_ALLOW_EPHEMERAL_STATE="${MISTER_MORPH_ALLOW_EPHEMERAL_STATE:-0}"

# Optional: seed new Console state from a YAML file, uploaded as a Worker secret.
# This does not overwrite config edited in Console or restored from R2.
export MISTER_MORPH_CONFIG_PATH="${MISTER_MORPH_CONFIG_PATH:-}"
# Optional: leave empty and complete model setup in Console.
export MISTER_MORPH_LLM_API_KEY="${MISTER_MORPH_LLM_API_KEY:-}"
export MISTER_MORPH_LLM_INFERENCE_PROVIDER="${MISTER_MORPH_LLM_INFERENCE_PROVIDER:-}"
export MISTER_MORPH_LLM_ENDPOINT="${MISTER_MORPH_LLM_ENDPOINT:-}"
export MISTER_MORPH_LLM_MODEL="${MISTER_MORPH_LLM_MODEL:-}"
export MISTER_MORPH_LOG_LEVEL="${MISTER_MORPH_LOG_LEVEL:-}"
export MISTER_MORPH_TOOLS_BASH_ENABLED="${MISTER_MORPH_TOOLS_BASH_ENABLED:-}"
export SKIP_NPM_INSTALL="${SKIP_NPM_INSTALL:-0}"
