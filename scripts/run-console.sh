#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/run-console.sh [console flags]
# Example: scripts/run-console.sh --console-listen 127.0.0.1:9081
# Requires Go. Builds a Linux backend without the embedded frontend and runs Console's API only;
# serve the frontend yourself, e.g. `pnpm --dir web/console dev` (it proxies to 127.0.0.1:9080).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "This script builds and runs Console on Linux." >&2
  exit 1
fi

# Use pinned dependencies by default; set GOWORK to opt into a local workspace.
GOOS=linux GOARCH="$(go env GOHOSTARCH)" GOWORK="${GOWORK:-off}" \
  ./scripts/build-backend.sh --no-embed-frontend --output "${ROOT_DIR}/bin/morph"

exec "${ROOT_DIR}/bin/morph" console "$@"
