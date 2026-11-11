---
branch: factory/FT92-mobile-back-button-size
round: 1
---
# Match mobile back buttons to the Todo calendar button

## factory · 2026-11-11 13:50
Recorded from the owner's UI fix request.

Request:
> The back button on mobile views seems to have different sizes compared to other buttons on the page bar. Looks smaller. Need to fix, to use the same size like the Todo view's calendar button.

Acceptance criteria:
- Audit mobile page-bar back buttons and match their button dimensions, icon size, padding, and alignment to the Todo view's calendar button.
- Prefer shared sizing styles over per-page overrides. Preserve accessible touch targets, labels, back navigation, and desktop layouts.
- Add regression coverage for consistent sizing. Visually compare affected mobile pages with the Todo calendar button on mobile web and Android; explicitly record any platform not checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 19:07
Behaviour: Match mobile page-bar back controls to Todo's calendar toggle, preserving labels, navigation, conditional visibility, and empty/error/first-run behaviour.
Scope: Audit shared MobileBar and Chat, Todo, Settings, Context, Skills and Skill Store page bars. Preserve desktop sizing; leave dialog and card-heading controls alone.
Decisions: Use Todo's standard plain icon-only Button sizing through a shared component rather than per-page overrides. Keep keyboard/system-back behaviour unchanged.
Checking: Add sizing and navigation regression coverage; run Go formatting, vet and tests plus nsh checks/tests. Compare mobile web visually; record unavailable platform checks.

## factory · 2026-11-11 19:07
Built and pushed add161b4 with Claude Code. Shared BackButton and BAR_BUTTON_SIZE align mobile back controls to the Todo calendar toggle: 38pt square, 16pt icon. Desktop Context/Skill Store retain 32pt sizing. Titles move 6pt right to accommodate the larger control. Audit card-heading arrows, dialog arrows and Chat sidebar toggle intentionally unchanged.
Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`; coder passed `nsh check` and `nsh test --web-host tests/noHost.js` (626 tests). Scripted tests used throwaway HOME. New regression coverage exercises mobile web, Android platform emulation, tablet-width phone layout, desktop, labels and presses; old sizing fails four of five cases.
Visual checks: coder compared real Console before/after in headless Chrome at 390×844 with touch and verified matching button/icon geometry. Android not visually checked: no device/emulator/KVM. Desktop app not visually checked: no display; desktop browser geometry checked.
Installs: none. Existing Playwright tooling reused.
Push initially failed because credential requests omitted repository path; one retry with command-local credential.useHttpPath=true succeeded.
Moved new/ → review/ for review; not merged into master.
