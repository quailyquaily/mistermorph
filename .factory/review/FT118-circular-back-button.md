---
branch: factory/FT118-circular-back-button
round: 1
---
# Make the back button circular

## factory · 2026-11-14 08:05
Owner request: "The back button should be circle button too. Put to new/"

Requirements:
- Make the Console back button circular, consistent with the other circular icon buttons, including the Progress workbench navigation where present.
- Use equal width and height and center the back icon; preserve a usable touch target on mobile web and Android.
- Retain existing navigation behavior, accessible labeling, keyboard focus, and hover/pressed states.
- Match existing theme colors and icon-button styling rather than introducing a separate visual style.

Acceptance checks:
- The back button is visibly circular, not square, rectangular, or pill-shaped, on desktop, mobile web, and Android.
- The icon remains centered, and the button does not stretch or clip at narrow widths.
- Back navigation and keyboard interaction continue to work; verify supported light/dark themes.

Scope: Back-button appearance and sizing; no navigation behavior changes.

## factory · plan · 2026-11-14 19:25
Behaviour: Back arrows use the existing plain circular icon-button styling across desktop, mobile web and Android, preserving labels, presses, navigation and theme colors. First-run, empty and error navigation remain unchanged.
Scope: Shared BackButton, separate Skill store desktop and Audit ledger back arrows, and regression tests. Progress workbench already uses a round TipButton and stays unchanged. No unrelated navigation or generated assets.
Decisions: Keep existing 38pt mobile/default and 32pt Context desktop targets, with centered 16pt shared arrows. Reuse CircleButton rather than add another style.
Checking: Test square geometry, centered icons, shared circular styling, light/dark themes, web/Android layouts, accessible labels and back presses; run nsh check, full nsh tests and the configured Go gate. Compare browser screenshots where possible.

## factory · 2026-11-14 19:25
Built e2edf50a (start point: 45c12569). Shared BackButton now uses CircleButton; separate Skill store and Audit ledger arrows use the same circle styling. Existing targets and navigation retained. Added layout/shape/theme/press coverage and Audit back-navigation checks.
Installs: none; reused existing pinned nsh 0.5.0 and existing Playwright tools. No manifest or lockfile changes.
Tests: configured gofmt/vet/go test gate passed, independently verified by manager. nsh check passed, independently verified. Full nsh suite: 937/938 passed; failing test: `tests/chat-composer-drum.test.tsx:53:29: expected 0 to be 1`. Follow-up: drum 6/6 passed, mobile-back-button 9/9 passed, Audit 6/6 passed. Full suite was not rerun. Baseline export at 45c12569 reproduces the same pre-existing intermittent drum failure (6/6 repeated file runs failed; HEAD 4/6 failed), so no unrelated composer changes were made.
Visual check: Chrome Chat hover screenshot shows the square-to-circle change with centered arrow; rest screenshots identical as expected for an unfilled plain button. Not manually checked: real Android device, desktop native app, dark mode, keyboard-focus appearance, Skill store desktop and Audit ledger screenshots. Automated light/dark and Android-platform layout checks passed. Review should examine these remaining manual checks and the pre-existing flaky drum test.
Push: initial credential-helper request lacked repository path; adding per-command credential.useHttpPath=true succeeded. No persistent credential/settings changes.
Moved new/ → review/ for review; not merged or deployed.
