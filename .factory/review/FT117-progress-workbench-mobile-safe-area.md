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
