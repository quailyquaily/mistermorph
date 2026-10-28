#!/usr/bin/env bash
# Submits a signed .zip, .dmg or .pkg to Apple notarization and waits for the result.
# Authenticates with an App Store Connect API key:
# APPLE_API_KEY_PATH (.p8 file), APPLE_API_KEY_ID and APPLE_API_ISSUER_ID.
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <file.zip|file.dmg|file.pkg>" >&2
  exit 2
fi
file="$1"

for name in APPLE_API_KEY_PATH APPLE_API_KEY_ID APPLE_API_ISSUER_ID; do
  if [[ -z "${!name:-}" ]]; then
    echo "missing ${name}; cannot notarize ${file}" >&2
    exit 1
  fi
done

auth=(--key "${APPLE_API_KEY_PATH}" --key-id "${APPLE_API_KEY_ID}" --issuer "${APPLE_API_ISSUER_ID}")

echo "submitting $(basename "${file}") for notarization..."
result="$(xcrun notarytool submit "${file}" "${auth[@]}" --wait --output-format json)"
id="$(/usr/bin/plutil -extract id raw -o - - <<<"${result}")"
status="$(/usr/bin/plutil -extract status raw -o - - <<<"${result}")"
echo "notarization ${id}: ${status}"

if [[ "${status}" != "Accepted" ]]; then
  xcrun notarytool log "${id}" "${auth[@]}" >&2 || true
  exit 1
fi
