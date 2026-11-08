#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/stage-console-assets.sh [SOURCE_DIR]
# Copies a built console (default: the Vue build in web/console/dist; the nsh console builds to
# web/console-nsh/dist) into the folder the backend embeds.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:-${ROOT_DIR}/web/console/dist}"
TARGET_DIR="${ROOT_DIR}/cmd/mistermorph/consolecmd/static"

if [[ ! -f "${SOURCE_DIR}/index.html" ]]; then
  echo "missing ${SOURCE_DIR}/index.html; build the console first ('pnpm --dir web/console build', or web/console-nsh/scripts/build-web.sh for the nsh console)" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"
find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
cp -R "${SOURCE_DIR}/." "${TARGET_DIR}/"

if [[ ! -f "${TARGET_DIR}/index.html" ]]; then
  echo "failed to stage console assets into ${TARGET_DIR}" >&2
  exit 1
fi

echo "Staged console assets:"
echo "  source: ${SOURCE_DIR}"
echo "  target: ${TARGET_DIR}"
