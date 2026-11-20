---
branch: factory/FT168-mobile-todo-empty-state-spacing
round: 1
---
# Add horizontal margins to the mobile TODO empty placeholder

## factory · 2026-11-20 14:50
The owner requested: "the Todo empty placeholder on mobile need left and right margin." Add this to new/ for the factory to implement.

### Current behavior
The supplied mobile screenshot shows the Scheduled section's dashed "No scheduled TODOs" placeholder extending to both screen edges, while its section heading is inset. The placeholder needs space outside its left and right borders, not merely more padding inside the card.

### Requirements
- Give the TODO empty placeholder consistent left and right outer spacing on mobile, using the Console's existing page gutters/spacing tokens and aligning it with neighboring section content.
- Keep the empty-state text and add-task action intact and usable. Avoid horizontal overflow or clipping at narrow viewport widths.
- Preserve desktop layout and populated TODO lists; do not redesign unrelated sections.
- Check the mobile empty state at representative narrow widths, including approximately 320px and 390px, and ensure desktop behavior is unchanged. Add focused regression coverage where practical; report any visual checks not performed.

### Reference
See `.factory/references/FT168/mobile-todo-empty-state.png` for the owner's screenshot.

## factory · plan · 2026-11-20 15:02

Behaviour: When the scheduled TODO collection is empty, inset the dashed add placeholder on mobile by gutterX() on both sides. Preserve its labels, action, loading/error paths and populated rows. At 320/390px the entire border and content must fit. Desktop spacing remains unchanged.
Scope: TodoIndex's empty placeholder and focused layout regression tests/fixtures. No populated-row, header, editor or unrelated layout changes.
Decisions: Use responsive gutterX rather than hardcoded padding. This is outer border spacing (wrapper padding or margin), not merely inner padding. Preserve the existing mobile empty marker alignment with the header icon if feasible by compensating its existing inner right padding; do not move the populated markers or change the desktop alignment. Account for narrower text width. Repository AGENTS.md states nsh 0.6.0, newer than the board's 0.5.0 note; use repository-pinned tooling and report discrepancies.
Checking: Add measured empty-border inset and overflow assertions at 320 and 390px, plus desktop unchanged and add action working; retain marker alignment coverage. Run nsh check, scripts/test.sh and the configured Go gate. Attempt representative visual checks and explicitly report any not performed.

## factory · 2026-11-20 15:02

Built in `6c1c98ac`. Mobile empty placeholder now has responsive gutterX outer spacing; inner right padding compensates to keep the plus icon aligned. Desktop gutters and populated rows remain unchanged. Added measured inset, text bounds, add-action and populated-row coverage at 320/390/800/1280 widths.

Tests: nsh check passed; focused layout tests 10 passed; required scripts/test.sh passed all 148 files (248s). Configured gofmt/vet/go test gate passed, independently rerun by manager. No unpinned installs or manifest changes. Used repository-pinned nsh 0.6.0 instead of stale board 0.5.0 note.

Visual checks: coder checked real TodoIndex fixture in headless Chrome at 320/390/1280; mobile border inset 12pt, desktop 16pt, no clipping. Visual fixture used nsh 0.5.1 web runtime because installed 0.6.0 has none; fonts were fallback sans. Full Console with backend, real Android, desktop app, real fonts, dark theme, non-English strings and before/after pixel diff were not checked. Owner should inspect mobile empty-state appearance in the actual Console.

Moved new/ → review/. Initial branch push needed command-local credential.useHttpPath=true; retry succeeded.
