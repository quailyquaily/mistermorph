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


## factory · review · 2026-11-15 02:29
head: 1c5b1f31f0f464ec8c5c0ea167914b04de5f40dd
verdict: pass
notes:
- Claude Code reviewed all five changed files in `origin/master...HEAD` and related geometry, text, selection and loading code. No qualifying P0–P3 findings.
- Validation passed: gofmt check, `go vet ./...`, `go test ./...` (163 packages), `nsh check`, and the required parallel Console script (112 files, 0 failed). Two unrelated files, chat-topic-drag and chat-scroll-anchor, passed the script's isolated retry.
- Successful test runs used a throwaway HOME. The coder initially launched the Go gate with the real HOME, killed it within seconds and discarded that result before rerunning correctly.
- Extra headless Linux layout probes at 300, 412 and 493 points passed. Android probe could not measure layout because its standalone fixture lacks a server address (`Invalid URL: /api/proxy…`). Android compact FadeText geometry remains unmeasured; existing Android coverage checks navigation and labels at 320 points only.
- No new installs. Worktree clean; no code commits or code pushes made during review.
- Not checked: physical Android device/emulator, GPUI rendering, screen reader or dark scheme. Owner should visually check compact Android names/handles before shipping.
- Moved from `review/` to `ready/`; no base branch or tag pushed.


## factory · 2026-11-15 08:42
Shipped with Claude Code at the owner's request. Moved ready/ → done/. Merge commit: 377200b31d072f704498f9307a1a84ade1ef74c1; pushed master head: 58f0ea3b78dd1610b4d6934d089e4b9112d7493b. No tags created or pushed.

Final validation: gofmt check, go vet ./..., go test ./..., nsh 0.5.0 check and required parallel Console script passed (118 files, 1026 tests). chat-attachments.test.tsx failed during parallel execution and passed the required solo retry; timing versus a genuine transient overlay remains unconfirmed. No unpinned installs. No real browser/device visual inspection or platform builds performed. Existing review risks remain unchanged.
Integration fix: 58f0ea3b78dd1610b4d6934d089e4b9112d7493b updates mobile-grid tests for separate Humans/Agents tabs; import conflict retained both intents.
No linked GitHub issue/PR in the item; none closed. Branch retained (clean action not configured).
