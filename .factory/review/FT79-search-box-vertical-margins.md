---
branch: factory/FT79-search-box-vertical-margins
round: 1
---
# Adjust search box vertical spacing

## factory · 2026-11-11 00:40
Owner requested this UI fix in Console; recorded in new for implementation.

Request: search box 的 margin top 再增加一些，margin bottom 再减少一些。

Acceptance:
- Increase the search box top margin and reduce its bottom margin relative to the current layout.
- Choose a modest adjustment consistent with existing spacing tokens; no exact pixel amount was requested.
- Verify the search box remains aligned and usable at narrow and wide window sizes without overlap or clipping.
- Limit changes to search box spacing; preserve search behavior.

## factory · plan · 2026-11-11 05:48
Behaviour: Move the shared Topics/Contacts search field down slightly, preserving total box height, gutters, input, clear and Escape behavior. Empty, loading, error and first-run states use the same spacing.
Scope: Shared indexSearchMetrics and its regression tests only; other search widgets remain unchanged.
Decisions: Change top/bottom from 4/4pt to 6/2pt, a modest 2pt shift with the same 8pt total.
Checking: Desktop and phone geometry/metrics tests, existing behavior and list-state coverage, Console check/tests and repository Go checks; inspect narrow/wide screenshots where available.

## factory · 2026-11-11 05:48
Built in 157812bb (fix(console-nsh): more room above the index search, less below).
Changed shared search spacing to 6pt above and 2pt below; total height and search behavior unchanged. Regression tests cover both viewport sizes.
Tests: manager independently passed gofmt cleanliness, go vet ./..., go test ./... with throwaway HOME. Claude Code reported nsh check passing and 524/524 Console tests passing; after removing a redundant assertion, nsh check and targeted index-search tests passed (8/8).
Visual checks: coder compared headless Chrome screenshots at 1280pt and 390pt; field top moved 61→63pt without differences below the box. Desktop screenshot had no rows. Full running Console, Android device/emulator, and native desktop window were not checked.
Installs: none reported. Coder reused existing pinned tooling and Playwright from an older build scratch directory; it also reported writing a tooling-memory note outside the requested worktree. These were outside the requested worktree isolation; no such files are part of this commit.
Initial push lacked credential HTTP-path configuration; retry with command-local credential.useHttpPath=true succeeded.
Moved new/ → review/ for review; not merged or shipped.
