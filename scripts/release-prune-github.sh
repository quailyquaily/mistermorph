#!/usr/bin/env bash
# Keeps only the newest GitHub releases. Older releases are deleted but their
# git tags stay, and their files remain on R2 and on the website.
#
# Usage: scripts/release-prune-github.sh <keep>
# Required environment: GH_TOKEN, GITHUB_REPOSITORY
set -euo pipefail

keep="${1:-}"
if [[ ! "${keep}" =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: $0 <keep>  (keep must be a positive integer)" >&2
  exit 1
fi

mapfile -t stale < <(
  gh release list \
    --repo "${GITHUB_REPOSITORY}" \
    --exclude-drafts \
    --limit 1000 \
    --json tagName,createdAt \
    --jq "sort_by(.createdAt) | reverse | .[${keep}:] | .[].tagName"
)

if (( ${#stale[@]} == 0 )); then
  echo "Nothing to prune; at most ${keep} GitHub releases exist."
  exit 0
fi

for tag in "${stale[@]}"; do
  echo "Deleting GitHub release ${tag} (tag kept)"
  gh release delete "${tag}" --repo "${GITHUB_REPOSITORY}" --yes
done
