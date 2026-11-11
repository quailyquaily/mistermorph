#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/dev-console.sh
# Runs the web Console with hot reload against a Console that is already running (`morph console`,
# 127.0.0.1:9080 by default, API), then open http://127.0.0.1:9082/ (DEV_PORT).
# It starts two things and stops both on Ctrl-C:
#   - nsh's web dev server (`nsh run --target web`), which serves the page and pushes an update
#     each time a source file is saved, on NSH_PORT;
#   - a proxy on DEV_PORT that puts the page and that Console's `/api` on one origin, because the
#     Console calls its API on the page's own origin (web/console-nsh/scripts/dev-proxy.mjs).
# Requires nsh and Node.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

DEV_PORT="${DEV_PORT:-9082}"
# Not nsh's 8790, so it runs beside an nsh session already open there.
NSH_PORT="${NSH_PORT:-8791}"
API="${API:-127.0.0.1:9080}"

for tool in nsh node; do
  command -v "${tool}" >/dev/null || { echo "dev-console: ${tool} is not installed" >&2; exit 1; }
done

pids=()
stop() {
  trap - INT TERM EXIT
  for pid in "${pids[@]}"; do kill "${pid}" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap stop INT TERM EXIT

(cd web/console-nsh && exec nsh run --target web --port "${NSH_PORT}") &
pids+=($!)
node web/console-nsh/scripts/dev-proxy.mjs --port "${DEV_PORT}" --api "${API}" --app "127.0.0.1:${NSH_PORT}" &
pids+=($!)

echo "dev-console: open http://127.0.0.1:${DEV_PORT}/  (API: ${API}; Ctrl-C stops)"
# One of them exiting (a port in use, a failed start) stops the other.
wait -n
