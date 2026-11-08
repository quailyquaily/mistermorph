---
branch: factory/FT29-console-button-loading-rendering
round: 1
---
# Fix button loading state not rendering in the web console

## factory · 2026-11-08 12:51
Owner report: "new factory UI bugs, on web console: the loading status of button, fail to render."

Investigate and fix button loading indicators that fail to render in the web console. The affected button and root cause have not yet been identified; inspect the shared button component and its loading-state callers rather than assuming a specific cause. This report is not restricted to desktop Chrome or mobile.

Acceptance criteria:
- Buttons with an active loading state visibly render their intended loading indicator for the duration of the pending action.
- Loading indicators remain visible with the console's supported button variants and themes, without unintended layout shifts.
- Loading clears correctly on both success and failure, preserving existing disabled-state and duplicate-submission behavior.
- Add regression coverage for loading-state rendering and transitions; verify representative buttons in the UI.

Registered only; not yet diagnosed or implemented.

## factory · 2026-11-08 13:28
Moved from new to backlog at the owner’s request: “move FT 26~29 to backlog”.

## lyric · 2026-11-08 18:04

FT29,28 放到 new

## factory · plan · 2026-11-08 19:50
Behaviour: show a visible indicator throughout pending actions; idle/first render has none; clear on success/failure; keep disabled and duplicate-submission protection.
Scope: investigate shared buttons and loading callers, fix the evidence-supported shared cause without unrelated restyling.
Decisions: retain existing variants/themes, labels/icons and geometry. Inspection expanded from Vue ui-kit to the default nsh console after Vue could not reproduce the failure.
Checking: pending/idle and success/error transitions, duplicate presses, variant visibility and stable width; browser checks plus console builds/tests and configured Go checks.

## factory · 2026-11-08 19:50
Built 39c09d18. The nsh Spinner had no indicator width/motion, producing a stationary dash; loading buttons also changed width. Added animated spinner and per-variant loading stripes, preserving label/icon and size, keeping filled variants visible while busy and blocking presses. Reduced-motion indicators remain stationary. Added regression tests/fixture and an English porting note. Vue shared buttons were checked with 60 loading caller class strings and needed no change.
Tests: manager independently passed configured gofmt cleanliness, go vet ./... and go test ./.... Coder reported Vue pnpm test 519/519 and build pass; nsh suite 252/252, nsh check/build pass, core tests 245/245. New regression tests fail before the fix and pass afterward.
Installs: none; no manifest/lockfile changes.
UI checked by coder in Linux headless Chrome 157 using nsh web tests and Vue file builds; before/after frames confirmed motion and restoration of idle appearance. Full backend-connected application, desktop GPUI, Android, Safari/Firefox, nsh busy hover and real-display contrast were not checked. Outlined/plain/ghost-danger stripes intentionally retain the existing very faint kit colours; contrast needs owner attention.
Moved new → review; no base merge.

## factory · review · 2026-11-08 19:59
head: 39c09d18d57903e6dd93a3a8da6111ba414c8d6b
verdict: pass
Codex reviewed all four changed files in origin/master...HEAD (merge base 8b613ef1); no qualifying findings. Branch merges cleanly with the fetched base.
Validation: configured gofmt cleanliness, go vet ./... and go test ./... passed. Vue pnpm build passed and pnpm test 519/519; nsh check/build passed and tests 252/252; core tests 245/245. Chromium loading regression tests 3/3 and additional browser checks 4/4 passed, covering six variants, light/dark appearance, motion/reduced motion, stable dimensions, duplicate press blocking and success/failure restoration.
Installs: no unpinned installs or manifest changes. Tracked worktree files unchanged.
Residual risks: real backend connection, physical display contrast, Firefox/Safari, desktop GPUI and Android were not verified. Faint loading stripes are drawn but owner should check their readability on a real display.
Moved review → ready; awaiting owner approval, not merged into base. No linked GitHub issues or PRs.

## factory · 2026-11-08 20:30
Merged into master at da3b43b8f85a8ee38998568b687e63101fbcfb16; released in v0.3.84 at b95f560b64af8a80ecbc84e5b5477bd86fb20552. No linked GitHub issues or PRs to close.
Combined verification passed: gofmt/vet/Go tests, Vue 519 tests and build, nsh typecheck/build and 265 tests, core 245 tests, Chrome button-loading regressions 3/3. No manifest changes or new unpinned installs. Android/iOS physical-device and emulator checks remain unperformed; real-display loading contrast remains unverified. No deployment performed. Moved ready → done.
