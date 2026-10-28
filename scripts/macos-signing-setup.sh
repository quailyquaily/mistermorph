#!/usr/bin/env bash
# Prepares a macOS CI runner for Developer ID signing and notarization.
#
# It imports the Developer ID Application certificate into a temporary
# keychain and writes the App Store Connect API key to a file. Later steps get
# CODESIGN_IDENTITY, APPLE_API_KEY_PATH, APPLE_API_KEY_ID and APPLE_API_ISSUER_ID
# through GITHUB_ENV.
set -euo pipefail

missing=()
for name in \
  APPLE_CERTIFICATE_BASE64 \
  APPLE_CERTIFICATE_PASSWORD \
  APPLE_CODESIGN_IDENTITY \
  APPLE_API_KEY_BASE64 \
  APPLE_API_KEY_ID \
  APPLE_API_ISSUER_ID \
  RUNNER_TEMP \
  GITHUB_ENV
do
  if [[ -z "${!name:-}" ]]; then
    missing+=("${name}")
  fi
done
if (( ${#missing[@]} > 0 )); then
  printf 'Missing required macOS signing settings:\n' >&2
  printf '  %s\n' "${missing[@]}" >&2
  exit 1
fi

cert_file="$(mktemp "${RUNNER_TEMP}/cert.XXXXXX")"
trap 'rm -f "${cert_file}"' EXIT
echo "${APPLE_CERTIFICATE_BASE64}" | base64 --decode > "${cert_file}"

keychain="${RUNNER_TEMP}/build.keychain-db"
keychain_pw="$(uuidgen)"
security create-keychain -p "${keychain_pw}" "${keychain}"
security set-keychain-settings -lut 21600 "${keychain}"
security unlock-keychain -p "${keychain_pw}" "${keychain}"
security import "${cert_file}" -P "${APPLE_CERTIFICATE_PASSWORD}" \
  -A -t cert -f pkcs12 -k "${keychain}"
security set-key-partition-list -S apple-tool:,apple: \
  -k "${keychain_pw}" "${keychain}" >/dev/null
security list-keychains -d user -s "${keychain}" $(security list-keychains -d user | tr -d '"')

if ! security find-identity -v -p codesigning "${keychain}" | grep -qF "\"${APPLE_CODESIGN_IDENTITY}\""; then
  echo "APPLE_CODESIGN_IDENTITY is not in the imported certificate. Identities found:" >&2
  security find-identity -v -p codesigning "${keychain}" >&2
  exit 1
fi

api_key_path="${RUNNER_TEMP}/AuthKey_${APPLE_API_KEY_ID}.p8"
echo "${APPLE_API_KEY_BASE64}" | base64 --decode > "${api_key_path}"
chmod 600 "${api_key_path}"

{
  echo "CODESIGN_IDENTITY=${APPLE_CODESIGN_IDENTITY}"
  echo "APPLE_API_KEY_PATH=${api_key_path}"
  echo "APPLE_API_KEY_ID=${APPLE_API_KEY_ID}"
  echo "APPLE_API_ISSUER_ID=${APPLE_API_ISSUER_ID}"
} >> "${GITHUB_ENV}"

echo "signing identity ready: ${APPLE_CODESIGN_IDENTITY}"
