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

## factory · review · 2026-11-11 19:30
head: add161b425dc26d7c76fda003c9d0825624858a6
verdict: pass
notes:
- Non-blocking sizing observation: on phone Chat with the workspace sidebar available, the back control is now 38×38 while the adjacent bare workspace toggle remains 32×32 (ChatPage.tsx:118,227,233). Claude Code rated this P3; manager treats it as an intentionally unchanged adjacent control, not a failure of the requested back-button sizing. Owner may consider matching it separately.

Reviewed all 10 changed files in origin/master...HEAD using Claude Code. No P0/P1 findings. Branch merges cleanly with origin/master. No files changed or commits created by reviewer.
Validation: Go formatting gate, go vet ./..., go test ./... passed; nsh check passed; nsh test --web-host tests/noHost.js passed (626 tests, 0 failed). Scripted tests used throwaway HOME. Installs: none.
Limits: reviewer did not independently visually inspect the UI; geometry tests cover mobile web and Android platform emulation. Real Android device/emulator and desktop app were not visually checked. Build's headless Chrome comparison remains the only visual evidence.
Moved review/ → ready/; not merged into master. No linked GitHub issues or PRs.

## factory · 2026-11-11 22:57
Shipped in owner-authorized batch FT80, FT85, FT86, FT91, FT92, FT93, merged in numeric order. Merge: 81bc0cae0648f4ca5a995c5eb7418a19929b10d5. Base master successfully pushed at d18743b3dfda935288e1a8fc4f739008ac14ed49 before this move. No tag created or pushed, per owner instruction.
Claude Code handled all fixes/review/conflicts; manager verified six merge parents, 11 item commits and 72 changed paths, with no forbidden paths or unrelated items. Targeted checks after this merge: 105/105 Console tests and nsh check passed; FT86 affected Go checks also passed. Final configured Go formatting/vet/tests passed (162 packages); nsh check and full Console suite passed 766/766. FT93 fix head 1666f8b4 was reviewed before shipment.
No linked GitHub issue/PR to close. Branch retained; no clean action requested. No unpinned installs or manifest changes; routine pinned TypeScript 7.0.2 cache restored. All scripted tests used absolute isolated HOME. No actual Android/emulator, iOS, native desktop or combined live-browser visual verification; existing nonblocking notes remain unchanged. Moved ready/ → done/ only after successful master push.
