#!/usr/bin/env bash
# Upload a directory of release files to R2: release-r2-upload.sh <dir> <s3-destination>
#
# R2 sometimes fails a large multipart upload (InvalidPart, or no response after the whole
# request was sent). Each file is overwritten by a later copy, so the copy is safe to repeat:
# it is tried up to RELEASE_R2_UPLOAD_ATTEMPTS times (default 3). The aws CLI's own retries
# and checksum settings come from the workflow's AWS_* variables.
set -euo pipefail

src="${1:?usage: release-r2-upload.sh <dir> <s3-destination>}"
dest="${2:?usage: release-r2-upload.sh <dir> <s3-destination>}"
attempts="${RELEASE_R2_UPLOAD_ATTEMPTS:-3}"
: "${R2_ENDPOINT:?R2_ENDPOINT is required}"

if [[ ! -d "$src" ]] || ! find "$src" -type f | grep -q .; then
  echo "no release files in $src" >&2
  exit 1
fi

# The first-byte timeout came from the CLI's CRT transfer client; use the classic one.
aws configure set default.s3.preferred_transfer_client classic

for ((attempt = 1; attempt <= attempts; attempt++)); do
  if aws s3 cp "$src" "$dest" --recursive --endpoint-url "$R2_ENDPOINT" --no-progress; then
    exit 0
  fi
  if ((attempt < attempts)); then
    echo "R2 upload attempt $attempt of $attempts failed; retrying in $((attempt * 15))s" >&2
    sleep $((attempt * 15))
  fi
done
echo "R2 upload failed after $attempts attempts" >&2
exit 1
