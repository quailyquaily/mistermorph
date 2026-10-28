#!/usr/bin/env bash
# GoReleaser post-build hook: signs and notarizes a darwin CLI binary.
#
#   macos-sign-cli.sh <binary path> <build target>
#
# Targets other than darwin are left alone. Without CODESIGN_IDENTITY the binary
# keeps the Go linker's ad hoc signature, which is fine for snapshots; set
# REQUIRE_MACOS_SIGNING=true to make that an error. A bare binary cannot carry a
# stapled ticket, so Gatekeeper looks the notarization up online on first run.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <binary> <target>" >&2
  exit 2
fi
binary="$1"
target="$2"

if [[ "${target}" != darwin_* ]]; then
  exit 0
fi

if [[ -z "${CODESIGN_IDENTITY:-}" ]]; then
  if [[ "${REQUIRE_MACOS_SIGNING:-}" == "true" ]]; then
    echo "CODESIGN_IDENTITY is required to sign ${binary}" >&2
    exit 1
  fi
  echo "no CODESIGN_IDENTITY set; leaving ${binary} unsigned"
  exit 0
fi

codesign --force --options runtime --timestamp \
  --sign "${CODESIGN_IDENTITY}" \
  "${binary}"
codesign --verify --strict --verbose=2 "${binary}"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/morph-notarize.XXXXXX")"
trap 'rm -rf "${work_dir}"' EXIT
zip_path="${work_dir}/morph-${target}.zip"
ditto -c -k --keepParent "${binary}" "${zip_path}"

"$(dirname "${BASH_SOURCE[0]}")/macos-notarize.sh" "${zip_path}"
