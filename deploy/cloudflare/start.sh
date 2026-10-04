#!/usr/bin/env sh
set -eu
umask 077

if [ -z "$(printf '%s%s' "${MISTER_MORPH_CONSOLE_PASSWORD:-}" "${MISTER_MORPH_CONSOLE_PASSWORD_HASH:-}" | tr -d '[:space:]')" ]; then
  echo "Console password is required." >&2
  exit 1
fi

STATE_DIR="${MISTER_MORPH_FILE_STATE_DIR:-/data/state}"
CACHE_DIR="${MISTER_MORPH_FILE_CACHE_DIR:-/tmp/mistermorph/cache}"
export MISTER_MORPH_FILE_STATE_DIR="${STATE_DIR}"
export MISTER_MORPH_FILE_CACHE_DIR="${CACHE_DIR}"
CONFIG_PATH="${STATE_DIR}/config.yaml"
BACKUP_INTERVAL="${MISTER_MORPH_R2_BACKUP_INTERVAL:-60}"
case "${BACKUP_INTERVAL}" in
  ''|*[!0-9]*|0) echo "R2 backup interval must be a positive number of seconds." >&2; exit 1 ;;
esac
if ! [ "${BACKUP_INTERVAL}" -gt 0 ] 2>/dev/null; then
  echo "R2 backup interval must be a positive number of seconds." >&2
  exit 1
fi

R2_ENABLED=0
if [ "${MISTER_MORPH_ALLOW_EPHEMERAL_STATE:-0}" != 1 ]; then
  for key in MISTER_MORPH_R2_ACCOUNT_ID MISTER_MORPH_R2_BUCKET MISTER_MORPH_R2_PREFIX MISTER_MORPH_R2_ACCESS_KEY_ID MISTER_MORPH_R2_SECRET_ACCESS_KEY; do
    if [ -z "$(printenv "${key}")" ]; then
      echo "Missing ${key}; R2 backup is required unless ephemeral state is explicitly enabled." >&2
      exit 1
    fi
  done
  R2_ENABLED=1
  R2_KEY="${MISTER_MORPH_R2_PREFIX%/}/state.tar.gz"
  R2_URI="s3://${MISTER_MORPH_R2_BUCKET}/${R2_KEY}"
else
  echo "Ephemeral state enabled: container replacement loses Console data." >&2
fi
mkdir -p "${STATE_DIR}" "${CACHE_DIR}"
BACKUP_DIR="$(mktemp -d "${CACHE_DIR}/state-backup.XXXXXX")"
trap 'rm -rf "${BACKUP_DIR}"' EXIT

r2() {
  AWS_ACCESS_KEY_ID="${MISTER_MORPH_R2_ACCESS_KEY_ID}" \
  AWS_SECRET_ACCESS_KEY="${MISTER_MORPH_R2_SECRET_ACCESS_KEY}" \
  AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required \
  AWS_MAX_ATTEMPTS=2 AWS_EC2_METADATA_DISABLED=true \
    aws --endpoint-url "https://${MISTER_MORPH_R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
      --region auto --cli-connect-timeout 10 --cli-read-timeout 60 "$@"
}

# Restore errors must stop startup. An empty R2 bucket is the only fresh-start case.
if [ "${R2_ENABLED}" = 1 ]; then
  object="$(r2 s3api list-objects-v2 --bucket "${MISTER_MORPH_R2_BUCKET}" \
    --prefix "${R2_KEY}" --max-keys 1 --query 'Contents[0].Key' --output text)" || {
    echo "R2 state restore failed; Console will not start." >&2
    exit 1
  }
  if [ "${object}" = "${R2_KEY}" ]; then
    r2 s3 cp "${R2_URI}" "${BACKUP_DIR}/restore.tar.gz" --only-show-errors
    tar -xzf "${BACKUP_DIR}/restore.tar.gz" -C "${STATE_DIR}"
  fi
fi

# A supplied config seeds new state only; preserve edits made in Console on restart.
if [ ! -f "${CONFIG_PATH}" ]; then
  if [ -n "${MISTER_MORPH_CONFIG_YAML:-}" ]; then
    printf '%s\n' "${MISTER_MORPH_CONFIG_YAML}" > "${CONFIG_PATH}"
  else
    cp "${MISTER_MORPH_CONFIG_TEMPLATE:-/app/config.example.yaml}" "${CONFIG_PATH}"
  fi
fi

backup_state() {
  # One object replaces the previous backup only after a complete upload succeeds.
  # A live backup is not a transaction across files; graceful shutdown saves quiescent state.
  tar -czf "${BACKUP_DIR}/state.tar.gz" -C "${STATE_DIR}" . || return 1
  r2 s3 cp "${BACKUP_DIR}/state.tar.gz" "${R2_URI}" --only-show-errors
}

SYNC_PID=""
if [ "${R2_ENABLED}" = 1 ]; then
  (
    sleep_pid=""
    trap 'if [ -n "${sleep_pid}" ]; then kill "${sleep_pid}" 2>/dev/null || true; fi; exit 0' INT TERM
    while true; do
      sleep "${BACKUP_INTERVAL}" &
      sleep_pid=$!
      wait "${sleep_pid}"
      sleep_pid=""
      if ! backup_state; then echo "Periodic R2 state backup failed." >&2; fi
    done
  ) &
  SYNC_PID=$!
fi

mistermorph --config "${CONFIG_PATH}" console serve --console-listen 0.0.0.0:8787 \
  --log-level "${MISTER_MORPH_LOG_LEVEL:-info}" &
APP_PID=$!
trap 'kill -TERM "${APP_PID}" 2>/dev/null || true' INT TERM
status=0
# wait can be interrupted by a trapped signal before the application has exited.
while true; do
  wait "${APP_PID}" && status=0 || status=$?
  if ! kill -0 "${APP_PID}" 2>/dev/null; then break; fi
done
if [ -n "${SYNC_PID}" ]; then
  kill -TERM "${SYNC_PID}" 2>/dev/null || true
  wait "${SYNC_PID}" 2>/dev/null || true
  if ! backup_state; then
    echo "Final R2 state backup failed." >&2
    if [ "${status}" = 0 ]; then status=1; fi
  fi
fi
exit "${status}"
