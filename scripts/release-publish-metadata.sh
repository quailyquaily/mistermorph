#!/usr/bin/env bash
# Rebuilds and uploads the metadata for one release in a channel:
#
#   <channel>/releases/<tag>/update.json   desktop update manifest
#   <channel>/releases/<tag>/release.json  notes and files, read by the website
#   <channel>/releases/index.json          every release in the channel, without notes
#   <channel>/latest/update.json           desktop update manifest of the newest stable tag
#
# It runs after the desktop builds, and again after the Windows signing
# workflow adds its files. Release notes come from the GitHub release.
#
# Required environment:
#   RELEASE_CHANNEL, RELEASE_TAG, R2_BUCKET, R2_ENDPOINT, R2_PUBLIC_BASE_URL,
#   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, GH_TOKEN, GITHUB_REPOSITORY
set -euo pipefail

missing=()
for name in RELEASE_CHANNEL RELEASE_TAG R2_BUCKET R2_ENDPOINT R2_PUBLIC_BASE_URL \
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY GH_TOKEN GITHUB_REPOSITORY; do
  if [[ -z "${!name:-}" ]]; then
    missing+=("${name}")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf 'Missing required release settings:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  printf 'AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY come from the R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY secrets.\n' >&2
  exit 1
fi
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

channel_prefix="${RELEASE_CHANNEL}"
release_prefix="${channel_prefix}/releases/${RELEASE_TAG}"
work_dir="dist/release-metadata"
rm -rf "${work_dir}"
mkdir -p "${work_dir}/checksums"

r2() {
  aws "$@" --endpoint-url "${R2_ENDPOINT}"
}

# Files that change after they are first written must not be cached for long.
upload_mutable() {
  r2 s3 cp "$1" "s3://${R2_BUCKET}/$2" \
    --content-type application/json \
    --cache-control "public, max-age=60" \
    --no-progress
}

gh api "repos/${GITHUB_REPOSITORY}/releases/tags/${RELEASE_TAG}" > "${work_dir}/release-source.json"

r2 s3api list-objects-v2 \
  --bucket "${R2_BUCKET}" \
  --prefix "${release_prefix}/" \
  --output json \
  > "${work_dir}/r2-objects.json"

r2 s3 cp "s3://${R2_BUCKET}/${release_prefix}/" "${work_dir}/checksums/" \
  --recursive \
  --exclude "*" \
  --include "MrMorph-*.sha256" \
  --no-progress
if ! find "${work_dir}/checksums" -type f -name '*.sha256' | grep -q .; then
  echo "missing desktop checksum files in ${release_prefix}/" >&2
  exit 1
fi

go run ./scripts/release-r2-metadata \
  -release-json "${work_dir}/release-source.json" \
  -r2-object-list "${work_dir}/r2-objects.json" \
  -download-base-url "${R2_PUBLIC_BASE_URL}" \
  -download-prefix "${release_prefix}" \
  -output "${work_dir}/release-r2.json"

go run ./scripts/release-update-manifest \
  -release-json "${work_dir}/release-r2.json" \
  -artifacts-dir "${work_dir}/checksums" \
  -output "${work_dir}/update.json"

# A missing index means this is the channel's first release.
if ! r2 s3 cp "s3://${R2_BUCKET}/${channel_prefix}/releases/index.json" "${work_dir}/index-existing.json" --no-progress 2>/dev/null; then
  echo "No existing ${channel_prefix}/releases/index.json; starting a new index."
  rm -f "${work_dir}/index-existing.json"
fi

go run ./scripts/release-index \
  -channel "${RELEASE_CHANNEL}" \
  -release-json "${work_dir}/release-source.json" \
  -r2-object-list "${work_dir}/r2-objects.json" \
  -download-base-url "${R2_PUBLIC_BASE_URL}" \
  -existing-index "${work_dir}/index-existing.json" \
  -release-output "${work_dir}/release.json" \
  -index-output "${work_dir}/index.json"

upload_mutable "${work_dir}/update.json" "${release_prefix}/update.json"
upload_mutable "${work_dir}/release.json" "${release_prefix}/release.json"
upload_mutable "${work_dir}/index.json" "${channel_prefix}/releases/index.json"

# Only the newest stable release moves latest, so re-running an older tag
# (for example a late Windows signing run) never rolls users back.
latest_tag="$(jq -r '.latest // ""' "${work_dir}/index.json")"
if [[ "${latest_tag}" == "${RELEASE_TAG}" ]]; then
  upload_mutable "${work_dir}/update.json" "${channel_prefix}/latest/update.json"
else
  echo "Skipping ${channel_prefix}/latest/update.json: ${RELEASE_TAG} is not the newest stable release (${latest_tag:-none})."
fi
