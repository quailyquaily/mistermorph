---
branch: factory/FT13-todo-scheduled-mobile-divider-indent
round: 1
---
# Fix Scheduled divider left indentation in mobile Todo view

## factory · 2026-11-05 10:55
The owner requested a new item: in the mobile Todo view, the Scheduled section divider has incorrect left indentation and should align the same way as the divider in Chat.

Acceptance criteria:
- Match the Scheduled divider's left inset to the corresponding Chat divider at mobile viewport widths.
- Check the actual Chat layout/styles as the reference rather than introducing an unrelated spacing value.
- Keep the Scheduled label and divider aligned consistently; preserve the existing desktop layout.
- Verify both Todo and Chat at mobile widths, and check desktop for regressions.

This item records the request only; implementation has not started.

## factory · plan · 2026-11-05 11:39
Behaviour: Match Scheduled's mobile inset to Chat's actual sidebar layout for populated and empty lists; leave loading, error and first-run behavior unchanged.
Scope: Narrow Todo CSS adjustment and focused regression coverage. No unrelated Chat or desktop changes.
Decisions: Use the shared sidebar layout as reference rather than add arbitrary spacing. Remove the redundant mobile margin; preserve desktop rules.
Checking: Compare actual Todo and Chat structures; regression-test responsive CSS; run frontend tests/build and repository formatting, vet and tests; browser-check mobile and desktop where available.

## factory · 2026-11-05 11:39
Built commit 20c1985e: removed the Scheduled divider's redundant mobile margin and added responsive indentation regression tests. Desktop styles are unchanged.
Coder reports Chrome checks at seven viewport widths with actual templates and mocked data: both dividers inset 14px on mobile and 30px on desktop; empty, populated and loading states checked.
Tests: frontend 389 tests and pnpm build passed; gofmt check, go vet ./... and go test ./... passed, independently repeated by manager. Frontend build retains a large-chunk warning.
Installs: no new unpinned tools or dependency manifest/lockfile changes reported.
Not checked: backend-connected full navigation, error and first-run flows; browser checks used mocked data.
Moved new/ → review/ for review; not merged into master.
