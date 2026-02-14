#!/usr/bin/env bash
# Copy to ./env.sh and fill values.
# Do not commit env.sh with real secrets.

# AWS settings.
export AWS_REGION="us-east-1"
# Optional: use a named AWS profile instead of default.
export AWS_PROFILE=""
# Optional: deployment credentials for local AWS CLI.
# Security policy: deploy.sh never passes AWS_* into container runtime env.
export AWS_ACCESS_KEY_ID=""
export AWS_SECRET_ACCESS_KEY=""
export AWS_SESSION_TOKEN=""
export LIGHTSAIL_SERVICE_NAME="mistermorph"
export LIGHTSAIL_POWER="micro"
export LIGHTSAIL_SCALE="1"

# Container settings.
export LIGHTSAIL_CONTAINER_NAME="mistermorph"
export LIGHTSAIL_IMAGE_LABEL="mistermorph"
# Optional: pre-defined local image tag. If empty, deploy.sh generates one.
export LIGHTSAIL_LOCAL_IMAGE=""

# Public endpoint / health check.
export LIGHTSAIL_CONTAINER_PORT="8787"
export LIGHTSAIL_HEALTH_PATH="/health"

# Runtime config path in this repo.
# Example: /home/you/Codework/arch/mistermorph/config.yaml
export MISTER_MORPH_CONFIG_PATH=""

# Required secrets for telegram mode.
export MISTER_MORPH_LLM_API_KEY="your-llm-api-key"
export MISTER_MORPH_TELEGRAM_BOT_TOKEN="your-telegram-bot-token"

# Optional runtime overrides.
export MISTER_MORPH_RUN_MODE="telegram"
export MISTER_MORPH_LLM_PROVIDER=""
export MISTER_MORPH_LLM_ENDPOINT=""
export MISTER_MORPH_LLM_MODEL=""
export MISTER_MORPH_LOG_LEVEL=""
export MISTER_MORPH_TOOLS_BASH_ENABLED="false"
export MISTER_MORPH_SERVER_AUTH_TOKEN=""
export MISTER_MORPH_FILE_STATE_DIR="/tmp/mistermorph/state"
export MISTER_MORPH_FILE_CACHE_DIR="/tmp/mistermorph/cache"
export MISTER_MORPH_SKIP_BOOTSTRAP_INSTALL="1"
export MISTER_MORPH_TELEGRAM_HEALTH_ENABLED="true"
export MISTER_MORPH_TELEGRAM_HEALTH_BIND="0.0.0.0"
# Keep this aligned with LIGHTSAIL_CONTAINER_PORT.
export MISTER_MORPH_TELEGRAM_HEALTH_PORT="8787"

# Optional S3 persistence for file_state_dir.
# When MISTER_MORPH_S3_STATE_BUCKET is set:
# - startup: restore from s3://bucket/prefix/state/
# - runtime: periodic sync
# - shutdown: final sync
export MISTER_MORPH_S3_STATE_BUCKET=""
export MISTER_MORPH_S3_STATE_PREFIX="default"
export MISTER_MORPH_S3_STATE_REGION=""
export MISTER_MORPH_S3_SYNC_INTERVAL="30"
# 1 = mirror deletions to S3, 0 = upload only.
export MISTER_MORPH_S3_SYNC_DELETE="1"
