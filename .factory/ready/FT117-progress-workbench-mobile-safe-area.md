---
branch: factory/FT117-progress-workbench-mobile-safe-area
round: 1
---
# Match Progress workbench safe-area background on mobile web and Android

## factory · 2026-11-14 08:03
Owner request: "the progress workbench panel needs a safe area with the same background color on mobile web and Android."

Requirements:
- Respect device safe-area insets in the Progress workbench panel on mobile web and Android, including the bottom gesture/navigation area and any relevant top or side insets.
- Extend the panel's background color through its safe area so there is no contrasting strip or exposed page background at the screen edge. Use the panel's current theme color rather than a hard-coded color.
- Keep panel content, scrolling, and controls clear of system UI; do not add duplicate inset padding when an outer container already handles it.
- Preserve desktop layout and zero-inset mobile behavior.

Acceptance checks:
- On mobile web with nonzero safe-area insets, the open Progress workbench has a continuous matching background and no obscured controls or output.
- Verify the same behavior in Android, including edge-to-edge/gesture navigation; check portrait and landscape where insets change.
- Check supported light/dark themes and panel open/close behavior. No extra blank strip or doubled padding on zero-inset devices or desktop.

Scope: Progress workbench panel safe-area layout and background; no unrelated panel redesign.

## factory · plan · 2026-11-14 18:42
Behaviour: On phones the open Progress workbench paints its own background through the bottom safe area and keeps content clear of system UI; inset/keyboard changes remain reactive. Top/side insets are taken once by the owning container. Closing restores the page; desktop and zero-inset layouts stay unchanged.

Scope: Workbench/frame inset ownership, navigation clearance and regression tests. No panel redesign, configuration or dependency changes.

Decisions: Reuse the existing terminal background constant. On Android phones the page column foot takes the bottom inset while the workbench and navigation strip are closed; the open workbench takes it internally instead. Frame retains Android top/side insets. Mobile web/iOS sheet takes side insets less its 8pt margins; keyboard height replaces, never adds to, the bottom inset. Increase minimum sheet height by its internal inset.

Checking: Cover Android gesture/button insets, landscape sides, mobile web, zero-inset phones, wide windows, keyboard, and open/close. Run configured Go gate, pinned nsh 0.5.0 check and full suite. Headless browser geometry/screenshots supplement tests; explicitly record device/theme limitations.

## factory · 2026-11-14 18:42
Built and pushed 31d49d34 on factory/FT117-progress-workbench-mobile-safe-area. Moved new/ → review/ (round 1).

Implemented Android phone bottom-inset ownership transfer from the frame to the page column foot or open workbench, continuous terminal background through the sheet safe area, mobile web/iOS side clearance, keyboard-aware padding and inset-aware minimum height. Added 9 safe-area regressions and updated affected Android/navigation/detail tests.

Installs: none; no manifests or lockfiles changed.

Tests: configured `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed, independently rerun by manager. Pinned nsh 0.5.0 check passed. Full nsh suite failed twice: 937 passed, 1 failed of 938 each run. Latest failing test: `chat-composer-drum.test.tsx:43:29 — android: typing turns the drum… — expected 0 to be 1`; first run failed at line 53. Existing unchanged base a72b391c reproduced the drum failure in 3/6 focused runs (branch 4/6). This is a pre-existing intermittent gate failure, deliberately not fixed in this item; review must see the non-green required suite. All 9 new tests pass; focused android 15/15, chat-detail-panel 22/22, chat-new-topic-nav 7/7 and mobile-nav-roots 12/12 pass.

UI checking: headless Chrome real web build with overridden safe-area insets, light theme, at 390×844 (47/0/34/0), 844×390 (0/47/21/47), zero-inset phone and 1280×800 desktop. Verified bottom padding, landscape cutout clearance, open/close and output screenshots against base. Real Android device/emulator, actual gesture/button system UI, real iOS/mobile browsers, desktop app and keyboard-up Chrome were NOT checked. Android inset/keyboard cases are headless tests only. Dark-theme visual checks were not performed; coder reports the web Console has no dark-mode handling. Owner should check real Android edge-to-edge and mobile safe-area rendering.

No linked GitHub issue or PR. Initial push needed command-scoped credential.useHttpPath=true; branch push then succeeded without persistent configuration changes.

## factory · review · 2026-11-14 19:12
head: 31d49d346d9f85168d6ec4b6ce3af0309b0b13a0
verdict: fix
fix:
- [P1] web/console-nsh/tests/chat-composer-drum.test.tsx:43: Required `nsh test --web-host tests/noHost.js` gate is not green: 936/938 passed, with the Android composer drum and persona avatar-preview tests failing. Obtain a green required run or owner disposition of the pre-existing failures before shipping; do not change unrelated behavior to hide the failures.
notes:
- Claude Code found no introduced code defects across all 13 changed files against origin/master (a72b391c). This P1 is a required-test gate finding under factory review rules, not a claim that FT117 caused either failure.
- Go gate (gofmt, go vet ./..., go test ./...) passed; pinned nsh 0.5.0 check passed. Focused safe-area 9/9, Android 15/15, detail 22/22, navigation roots 12/12 and new-topic navigation 7/7 passed.
- Composer drum focused reruns failed 2/3 on branch and 1/3 on unchanged base; the Linux variant also failed. Avatar preview focused reruns passed 3/3 on branch and 3/3 on base; its full-suite failure remains an intermittent validation issue, not a confirmed introduced defect.
- Installs: none. No code changes or commits made by reviewer; worktree clean.
- Real Android system UI, real mobile browsers, keyboard-up visuals, dark theme and on-device open/close animation remain unchecked.
- No linked GitHub issues or PRs. Moved review/ → new/ for fix round 2 (round 1 of max 3).

## factory · review · 2026-11-14 20:42
head: 6e4b1c34637dd07ec637dfed5fee1d0a9e711e75
verdict: pass
notes:
- Review by Claude Code in the owner's session, at the owner's request; the owner then asked for the move to ready/. No fix round was built: the round 1 finding was the test gate, not this item's code.
- The branch now holds master (merge 6e4b1c34 of f9e8da5e, no conflicts) over the item's one commit 31d49d34.
- No defects found in the 7 changed source files against master. Traced who takes the bottom inset on Android phones in every case (keyboard up, navigation strip, open workbench, the page column's foot): it is taken once and never dropped, on login and standalone pages too. Wide windows and desktop are unchanged. In phone browsers the sheet pads itself by the bottom inset and by the side insets less its 8pt margin.
- Go gate (gofmt, go vet ./..., go test ./...) passed on this head. `nsh check` passed.
- Console suite on this head: web/console-nsh/scripts/test.sh, which master now has (one `nsh test` per file, several at a time; a file that failed runs once more alone): 109 files, 0 failed. The serial `nsh test --web-host tests/noHost.js` run was still going when this was written, with no failure so far.
- The round 1 P1: chat-composer-drum counts the drum in the frame right after a keypress and misses it on a busy machine. It fails the same way on master and passes alone; this item does not touch it. The avatar-preview failure did not recur.
- Still unchecked: a real Android device's system bars, real phone browsers, keyboard-up visuals, dark theme, and the open and close animation on a device.
