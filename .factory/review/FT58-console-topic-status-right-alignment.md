---
branch: factory/FT58-console-topic-status-right-alignment
round: 1
---
# Align topic status marks with the topbar action right edge

## factory · 2026-11-10 08:56
Requested by the owner in Console.

Align the right edge of each topic item’s status mark with the plus button’s right edge on mobile, and with the rightmost topbar action button’s right edge on larger views. Use consistent list/topbar spacing across viewport sizes; preserve readable titles and prevent overlap or clipping.

Registered in new; not diagnosed or implemented.

## factory · plan · 2026-11-10 10:50
Behaviour: Align the outer right edge of topic status marks with the rightmost header action hit area on phones and larger views, including split mode without the New button. Preserve running, pending, unread and no-status rows, empty/loading states, groups and search.
Scope: TopicSidebar spacing and focused regression tests; no status semantics, other lists or font-size changes.
Decisions: Use shared inset spacing rather than per-row measurements; account for row border and list gutter. Interpret button edge as its hit-area edge, not icon centre. Preserve readable titles and touch targets.
Checking: Measure mobile, desktop, split-mode, long-title and no-status layouts; run Console checks/tests and the configured Go suite. Record limits of visual inspection.

## factory · 2026-11-10 10:50
Built and pushed fb3ab9cd. Mobile rows use the shared page gutter minus their 1pt border; desktop header actions now use the existing row inset of 30pt. The rightmost toggle is used in split mode. Added layout regression coverage for desktop, phone, tablet, loading/empty lists and activity states; tests fail with the old spacing. An optional layout callback supports test measurements.
Decision: On desktop the header actions move left to meet the rows, keeping marks inside their selection highlight; the action edge is consequently 14pt inside the search field edge. Owner should check this visual choice.
Tests: nsh check passed; full nsh test --web-host tests/noHost.js passed (408 tests), then check and 5 focused tests passed after a comment-only edit. Configured gofmt/go vet/go test suite passed in coder run and independent manager verification, with throwaway HOME.
Installs: none.
Visual check: coder inspected fixture screenshots in headless Chrome for desktop and phone layouts. Real running Console, desktop app and Android device were not inspected.
Moved new/ → review/; ready for review, not merged.
