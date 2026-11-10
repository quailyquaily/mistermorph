---
branch: factory/FT84-topic-cron-status-marker-alignment
round: 1
---
# Align topic and cron status markers with the topbar rightmost icon

## factory · 2026-11-11 01:04
Requested by the owner:

> UI fix:
> This topic item and cron item status mark, they have to align with the most right buttons icon at the page/column 2 topbar. Align with the middle axis.
> Add to new

Acceptance criteria:
- On both topic and cron lists, align the center of each item’s status marker with the vertical center axis of the rightmost button icon in the corresponding page / second-column topbar (same horizontal position).
- Align by icon/marker centers, not their outside edges or button hit-area edges.
- Preserve this alignment across supported responsive layouts, without changing status behavior or button interactions.

This request only records the UI fix; implementation has not started.

## factory · plan · 2026-11-11 08:36

Behaviour: Topic and cron list status marker centers share the horizontal coordinate of the rightmost topbar icon, on desktop, phone and tablet layouts. Preserve every status, hit target and interaction. Empty lists retain header alignment; long labels truncate before markers; errors retain existing behavior.
Scope: Correct Console list geometry and regression tests only. Inspect cron list separately from cron-run topic rows. Do not alter status semantics or redesign headers.
Decisions: Existing topic tests explicitly align outside edges; replace that contract with center alignment. Keep header hit areas and layout unchanged, derive marker inset from button/icon center and marker half-width rather than guessing visual offsets. Use existing responsive gutters and small shared metrics where appropriate.
Checking: Update existing topic-status-alignment tests and cover cron list markers, desktop/mobile/tablet and split/plus modes, status variants and long labels. Run repository Go gate, nsh check and full nsh tests with isolated HOME. Attempt rendered geometry/screenshot checks and report any unavailable visual/device checks.

## factory · 2026-11-11 08:36

Built ed1cb6dc: topic markers and TODO/cron markers now align by center with the rightmost header icon. Added responsive geometry regressions and shared opt-in layout probes. Status behavior and hit targets unchanged.

Decision/deviation: desktop TODO header right padding changes from 0 to 29pt because the existing list gutter makes marker-only alignment impossible without changing the list gutter. Mobile headers and all button hit areas unchanged. Rows without topic markers end at the marker edge.

Tests: manager independently passed gofmt check, go vet ./..., go test ./... with a throwaway HOME. Coder passed nsh check and full nsh suite (531 passed, 0 failed). Old formulas fail the new regression tests. No unpinned tools installed or dependency manifests changed.

Visual checks: coder reports before/after Chrome screenshots at desktop 1280 and phone 390 with pixel measurements. Topic screenshot scratch copies required a fix from unmerged FT76 for the existing master 'Cannot redefine property: ref' crash; this unrelated fix was NOT included. These screenshots are not evidence of an unmodified branch working in Chrome. No live Console, GPUI desktop, or Android device/emulator checked; tablet checked by headless layout only. Review should examine desktop header spacing and the pre-existing browser runtime limitation.

Branch push initially required credential.useHttpPath=true; retry succeeded. No base push or shipping performed.

## factory · review · 2026-11-11 08:51
head: ed1cb6dc90444c47350e1d3a627afb3864bcf73b
verdict: pass
notes:
- Claude Code reviewed all eight changed files against origin/master and the request/plan; no introduced P0/P1/P2/P3 defects found. Desktop TODO header padding, responsive marker-center geometry, overlay scrollbars, status behavior and hit targets checked.
- Validation: gofmt gate, go vet ./..., go test ./... and nsh check passed; nsh test --web-host tests/noHost.js passed 531 tests, zero failures, including twelve alignment cases. Scripted tests used an isolated HOME. Worktree remained clean at the reviewed head.
- No unpinned installs or manifest changes. Only pinned nsh TypeScript cache restored.
- Visual limitation: headless layout only; no live Console, Chrome, GPUI or Android validation. Existing browser StatusDot ref crash is not introduced here; FT76 contains its separate fix. Builder screenshots used a patched scratch copy and do not validate this exact branch. Owner should check real-browser rendering and desktop TODO header spacing when that fix is available.
