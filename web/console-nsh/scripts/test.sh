#!/bin/sh
# Runs the console's tests, one `nsh test` per test file, several at a time: a test waits on real
# time far more than it computes, and each file's apps are its own, so the files do not disturb
# each other. One after another the suite takes about a quarter of an hour.
#
# Usage: scripts/test.sh [test file ...]   (default: every tests/*.test.tsx)
#   JOBS=8 scripts/test.sh                 files at a time (default: the machine's cores)
#   WEB_TESTS=0 scripts/test.sh            without the run in Chrome (`nsh test --target web`)
# A failed file's output is printed, and all of it is kept in the folder named at the end.
set -eu
app=$(cd "$(dirname "$0")/.." && pwd)
cd "$app"
jobs=${JOBS:-$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)}
logs=$(mktemp -d)
all=0
[ $# -gt 0 ] || { all=1; set -- tests/*.test.tsx; }
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
# With the whole suite: the UI component gallery's inventory against the sources (a new component
# must be listed there, pages/ui-components/inventory.js).
if [ "$all" -eq 1 ]; then
  if node --test scripts/ui-components-inventory.test.mjs >"$logs/ui-components-inventory.log" 2>&1; then
    echo "ok    scripts/ui-components-inventory.test.mjs"
  else
    failed=$((failed + 1))
    echo
    echo "---- scripts/ui-components-inventory.test.mjs"
    cat "$logs/ui-components-inventory.log"
  fi
fi
# And the colours' tints against their steps (scripts/color-steps.test.mjs).
if [ "$all" -eq 1 ]; then
  if node --test scripts/color-steps.test.mjs >"$logs/color-steps.log" 2>&1; then
    echo "ok    scripts/color-steps.test.mjs"
  else
    failed=$((failed + 1))
    echo
    echo "---- scripts/color-steps.test.mjs"
    cat "$logs/color-steps.log"
  fi
fi
# And the TestFlight submission against a fake App Store Connect (scripts/testflight-submit.test.mjs).
if [ "$all" -eq 1 ]; then
  if node --test scripts/testflight-submit.test.mjs >"$logs/testflight-submit.log" 2>&1; then
    echo "ok    scripts/testflight-submit.test.mjs"
  else
    failed=$((failed + 1))
    echo
    echo "---- scripts/testflight-submit.test.mjs"
    cat "$logs/testflight-submit.log"
  fi
fi
# And every Image clipping its source (scripts/image-clip.test.mjs).
if [ "$all" -eq 1 ]; then
  if node --test scripts/image-clip.test.mjs >"$logs/image-clip.log" 2>&1; then
    echo "ok    scripts/image-clip.test.mjs"
  else
    failed=$((failed + 1))
    echo
    echo "---- scripts/image-clip.test.mjs"
    cat "$logs/image-clip.log"
  fi
fi
# And the QR scanner's page (lib/qrScannerPage.js), which runs in a web view no test here opens:
# against a browser made of fakes.
if [ "$all" -eq 1 ]; then
  if node --test lib/qrScannerPage.test.mjs >"$logs/qr-scanner-page.log" 2>&1; then
    echo "ok    lib/qrScannerPage.test.mjs"
  else
    failed=$((failed + 1))
    echo
    echo "---- lib/qrScannerPage.test.mjs"
    cat "$logs/qr-scanner-page.log"
  fi
fi
# And the job calendar's rules (components/todo/calendar-runs.js): what folds, what is planned.
if [ "$all" -eq 1 ]; then
  if node --test components/todo/calendar-runs.test.mjs >"$logs/calendar-runs.log" 2>&1; then
    echo "ok    components/todo/calendar-runs.test.mjs"
  else
    failed=$((failed + 1))
    echo
    echo "---- components/todo/calendar-runs.test.mjs"
    cat "$logs/calendar-runs.log"
  fi
fi
# And the pasted images in a real browser (`nsh test --target web`: the installed Chrome, Edge or
# Chromium, headless), where a paste is a ClipboardEvent the page's runtime reads. WEB_TESTS=0
# skips it on a machine without one, and says so. (A long TMPDIR makes Chrome refuse to start: its
# socket path is too long; a short or relative one works.)
if [ "$all" -eq 1 ]; then
  if [ "${WEB_TESTS:-1}" = 0 ]; then
    echo "skip  tests/chat-image-paste-web.test.tsx in Chrome (WEB_TESTS=0)"
  elif nsh test --target web tests/chat-image-paste-web.test.tsx >"$logs/image-paste-web.log" 2>&1; then
    echo "ok    tests/chat-image-paste-web.test.tsx in Chrome  $(tail -n 1 "$logs/image-paste-web.log" | sed "s/^[^(]*//")"
  else
    failed=$((failed + 1))
    echo
    echo "---- tests/chat-image-paste-web.test.tsx in Chrome"
    cat "$logs/image-paste-web.log"
  fi
fi
echo
echo "$# files, $failed failed, $(($(date +%s) - started))s (output: $logs)"
[ "$failed" -eq 0 ]
