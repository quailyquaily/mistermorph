#!/usr/bin/env bash
set -euo pipefail

# Usage: scripts/stage-console-assets.sh [SOURCE_DIR]
# Copies the built Console (default: web/console-nsh/dist, from
# web/console-nsh/scripts/build-web.sh) into the folder the backend embeds.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${1:-${ROOT_DIR}/web/console-nsh/dist}"
TARGET_DIR="${ROOT_DIR}/cmd/mistermorph/consolecmd/static"

if [[ ! -f "${SOURCE_DIR}/index.html" ]]; then
  echo "missing ${SOURCE_DIR}/index.html; build the console first (web/console-nsh/scripts/build-web.sh)" >&2
  exit 1
fi

mkdir -p "${TARGET_DIR}"
find "${TARGET_DIR}" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +
cp -R "${SOURCE_DIR}/." "${TARGET_DIR}/"

if [[ ! -f "${TARGET_DIR}/index.html" ]]; then
  echo "failed to stage console assets into ${TARGET_DIR}" >&2
  exit 1
fi

# Precompressed copies: the server sends name.br / name.gz to browsers that accept them
# (cmd/mistermorph/consolecmd/static_assets.go). The nsh build writes its own for most files;
# text files of 1 KB or more it left without one get a gzip copy here.
compressed=0
while IFS= read -r -d '' file; do
  if [[ -e "${file}.gz" || -e "${file}.br" ]]; then
    continue
  fi
  if [[ "$(wc -c <"${file}")" -lt 1024 ]]; then
    continue
  fi
  gzip -9 -n -k "${file}"
  compressed=$((compressed + 1))
done < <(find "${TARGET_DIR}" -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.svg' \
  -o -name '*.json' -o -name '*.webmanifest' -o -name '*.wasm' -o -name '*.txt' -o -name '*.ttf' \) -print0)

echo "Staged console assets:"
echo "  source: ${SOURCE_DIR}"
echo "  target: ${TARGET_DIR}"
echo "  gzipped: ${compressed} files"
