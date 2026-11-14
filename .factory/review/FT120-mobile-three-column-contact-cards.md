---
branch: factory/FT120-mobile-three-column-contact-cards
round: 1
---
# Mobile contact cards: at least three cards per row

## factory · 2026-11-15 01:12

Owner request:
> new UI request, on mobile, at least show 3 cards in one row. Take care of the avatar size and font size.
> Put it to new/

Scope assumption: this refers to the Contacts card grid discussed in this thread, covering both human and agent contacts.

Acceptance criteria:
- On mobile portrait layouts, display at least three contact cards per row without horizontal page overflow.
- Adjust card spacing, padding, avatar dimensions, and font sizes together so the three-column layout remains readable and usable.
- Long names and other card text must stay within their cards, using appropriate wrapping or truncation without breaking the grid.
- Preserve contact selection/navigation, existing information and accessible interaction targets; do not change desktop layout unnecessarily.
- Verify narrow mobile widths (320, 360, 390, and 430 CSS pixels), including long names and missing avatars, for both contact types.

Request recorded only; not implemented.

## factory · plan · 2026-11-15 01:57

Behaviour: On phone Contacts, display at least three equal-width cards per row within the measured list width. Compact avatars, type, padding and gaps together; contain long names/handles with single-line fading and preserve full accessible labels. Keep kind/channel information, full-card interaction, detail navigation and empty/error/first-run behavior. Align loading placeholders, virtualization and selection with the actual geometry.

Scope: Contacts grid geometry, responsive cards and regression tests; no unrelated pages, backend or desktop redesign.

Decisions: Reuse the existing mobile breakpoint; keep the regular 150pt phone preference where three cards already fit, otherwise use three compact cards. Desktop presentation stays regular. Derive row height and selection positioning from the same geometry.

Checking: Measure real page/card parts at 320, 360, 390 and 430 CSS pixels, mixed human/agent contacts, long names, missing names/avatars, loading, resize, navigation and desktop regression. Run Go gate, nsh check and parallel Console test script.

## factory · 2026-11-15 01:57

Built and pushed `1c5b1f31f0f464ec8c5c0ea167914b04de5f40dd` on `factory/FT120-mobile-three-column-contact-cards`.

Compact phone cards use 44pt avatars, 13pt names, 9pt kinds and 10pt handles; 142pt row height and 8pt gaps. Updated loading placeholders, selection/scroll geometry and font-size regression expectations. Added real-page layout tests and a test fixture covering narrow widths, long text, fallbacks, both contact kinds and navigation.

Installs: none reported; reused existing tools and pinned dependencies.

Manager verification: gofmt check, `go vet ./...`, `go test ./...`, `nsh check`, and `web/console-nsh/scripts/test.sh` all passed with a throwaway HOME. Full Console suite: 112 files, 0 failed. The coder initially encountered a font-size expectation failure; updated the expected compact phone sizes, and the manager reran the complete suite successfully.

Not checked: physical Android device/emulator, GPUI desktop visual rendering, screen reader, before/after desktop screenshots and dark scheme. Automated layout checks do not replace those visual checks.

Moved from `new/` to `review/`, round 1. No base branch or tag was pushed.
