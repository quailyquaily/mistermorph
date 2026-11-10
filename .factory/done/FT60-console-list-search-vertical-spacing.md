---
branch: factory/FT60-console-list-search-vertical-spacing
round: 1
---
# Adjust topic and contacts search box vertical spacing

## factory · 2026-11-10 09:02

User request:
> Add some margin top to the search box on the topic list and contacts, remove the same amount of margin bottom.

Acceptance criteria:
Move an equal amount of spacing from below the search box to above it on both topic and contacts lists, preserving the overall vertical space. Use existing design spacing values; preserve mobile pull-down search behavior and avoid changing unrelated topbar controls.

Registered for implementation; not yet diagnosed or implemented.

## factory · plan · 2026-11-10 11:28

Behaviour: Move the shared Topics and Contacts search field down 4pt, changing top/bottom padding from 0/8 to 4/4 while preserving total height. Apply consistently on desktop and phone, including loading, empty and error lists and revealed mobile pull-down search. Filtering, clear and Escape stay unchanged.

Scope: Shared indexSearchMetrics, its comment and regression assertions; no unrelated topbar controls or gesture changes.

Decisions: Use the existing 4pt design increment and existing padding rather than a new wrapper or margins.

Checking: Assert top=4, bottom=4 and total=8 with unchanged field/box heights on desktop and phone. Run Go gate, nsh check and full nsh tests including pull-down search. Inspect visual geometry where possible.

## factory · 2026-11-10 11:28

Built and pushed commit 712282f2. Shared index search now has 4pt above and 4pt below, preserving overall spacing. Updated desktop and phone regression coverage. Only the shared component and its tests changed; protected paths unchanged.

Tests: configured gofmt, go vet and go test gate passed, independently rerun by manager. nsh check passed; nsh tests: 403 passed, 0 failed, including pull-down search and loading/empty/error states. Tests used throwaway HOME.

Installs: none; no manifest changes.

Visual checks: coder compared isolated before/after fixture screenshots at desktop and phone widths; field moved down 4pt, mobile first row stayed fixed. Desktop fixture did not render rows in either version. Actual Topics/Contacts pages were not visually inspected; fixture fonts were not loaded. No real Android/emulator pull-down gesture was checked.

Moved new/ → review/. Owner should check the spacing on the actual Topics and Contacts pages.

## factory · review · 2026-11-10 12:22
head: 712282f22cf157c3711926a00f1c18338806147b
verdict: pass
notes:
- Codex reviewed origin/master...HEAD (base c89e4e14); no findings. Shared search padding changes from 0/8 to 4/4 without changing total spacing or pull-down behavior.
- Configured gofmt, go vet and go test gate passed. Console nsh check passed; nsh tests passed 403/403. Tests used an absolute throwaway HOME.
- Installs: only restored pinned dependencies; no non-pinned installs. Tracked files remained unchanged.
- Actual pages were not visually inspected; real Android pull-down gestures were not checked. Owner should inspect actual Topics and Contacts spacing.

## factory · 2026-11-10 23:38
Merged into master at 277be65ed3f17f358129fc63469aff1c7f8a790f. Released in v0.3.93; base and annotated tag pushed atomically. Moved ready/ → done/.

Validation on the final integrated base: manager gofmt cleanliness, go vet ./... and go test ./... passed; nsh 0.4.0 check passed and full console suite passed (524/524). Tests used a throwaway HOME. The first final console run exceeded the tool timeout and was confirmed stopped before the successful rerun. after_change is empty. No forbidden paths changed.

Linked issues/PRs: none (no source or owner closure links); nothing to close. Installs: none. Native desktop windows, real Android/device rendering, Windows/macOS and real IME/accessibility were not verified during ship; existing review notes remain.
