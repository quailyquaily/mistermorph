#!/bin/sh
# Runs the console's tests, one `nsh test` per test file, several at a time: a test waits on real
# time far more than it computes, and each file's apps are its own, so the files do not disturb
# each other. One after another the suite takes about a quarter of an hour.
#
# Usage: scripts/test.sh [test file ...]   (default: every tests/*.test.tsx)
#   JOBS=8 scripts/test.sh                 files at a time (default: the machine's cores)
# A failed file's output is printed, and all of it is kept in the folder named at the end.
set -eu
app=$(cd "$(dirname "$0")/.." && pwd)
cd "$app"
jobs=${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}
logs=$(mktemp -d)
[ $# -gt 0 ] || set -- tests/*.test.tsx
started=$(date +%s)
printf '%s\n' "$@" | LOGS="$logs" xargs -P "$jobs" -I {} sh -c '
  log="$LOGS/$(basename "$1").log"
  if nsh test --web-host tests/noHost.js "$1" >"$log" 2>&1; then
    echo "ok    $1  $(tail -n 1 "$log" | sed "s/^[^(]*//")"
  else
    echo "FAIL  $1"
    touch "$log.failed"
  fi
' sh {} || true
# A few tests look at a frame right after a change, and miss it when the machine is busy: a file
# that failed runs once more by itself, and fails only if it fails again.
failed=0
for mark in "$logs"/*.failed; do
  [ -e "$mark" ] || continue
  log=${mark%.failed}
  file="tests/$(basename "$log" .log)"
  if nsh test --web-host tests/noHost.js "$file" >"$log.again" 2>&1; then
    echo "ok    $file  on its own, after failing beside the others"
    continue
  fi
  failed=$((failed + 1))
  echo
  echo "---- $file"
  cat "$log.again"
done
echo
echo "$# files, $failed failed, $(($(date +%s) - started))s (output: $logs)"
[ "$failed" -eq 0 ]
