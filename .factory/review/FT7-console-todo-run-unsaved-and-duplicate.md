---
branch: factory/FT7-console-todo-run-unsaved-and-duplicate
round: 1
---
# Console TODO: run with unsaved changes, and duplicate

## lyric · 2026-11-03 22:40

Two changes to the TODO item panel's top-right menu (`taskActionMenuItems` in `web/console/src/views/TodoView.js`).

1. **Run manually with unsaved changes.** "Run manually" is now disabled while the item has unsaved changes (`selectedTaskHasLocalChanges`). Keep it enabled; when clicked with unsaved changes, save the item first and then run the saved version.
2. **Duplicate.** Add a "Duplicate" entry to the menu, just above "Move up". It creates a copy of the item and selects the copy.

### Acceptance criteria
- With unsaved changes, "Run manually" is enabled. Clicking it saves, then runs; the run uses the saved content.
- If the save fails or the form does not validate, nothing runs and the save error is shown as for the Save button. Run stays disabled for the other existing reasons (heartbeat, loading, saving, already running).
- "Duplicate" appears directly above "Move up" and is disabled while loading or saving.
- The copy has the same fields as the original (content, schedule, timezone, workspace_dir, bash env, chat, enabled state) with a new ID; its title marks it as a copy. It is placed right after the original and becomes the selected item.
- Duplicating an item with unsaved changes copies what the form shows. Whether the original's changes are kept or discarded is decided and stated in the item's plan.
- New strings are added to the en, zh and ja translations.
- Regression coverage for save-then-run, a failed save not running, and duplicate.

## factory · plan · 2026-11-03 23:20

Behaviour: Manual run stays available for dirty ordinary tasks. Validate via the Save path, await successful persistence, then run the saved ID; validation/save failure never runs. Preserve loading/saving/running/heartbeat and identity guards, and prevent concurrent launches or running a different selection after awaiting. Clean tasks run directly. Empty/first-run lists have no runnable selection. Duplicate appears directly above Move up, is guarded while loading/saving, deep-copies displayed fields with new ID/internal key and localized copy title, inserts after the source and selects the copy.

Scope: TODO view, en/zh/ja translations and regression tests. No backend or unrelated UX changes.

Decisions: Duplication preserves the original's unsaved edits locally by committing its draft to the local task list. The copy is also unsaved, following existing Save semantics; neither is implicitly persisted. Nested fields are independently copied. Existing ID and normalization conventions are retained.

Checking: Cover save-before-run and saved content, clean direct run, validation/save failure, concurrency and stable target guards, duplicate fields/identity/adjacency/selection, draft retention and deep-copy isolation, menu order and translations. Run required Go checks, console tests/build and available browser smoke checks.

## factory · 2026-11-03 23:20

Built and pushed commit 8ab5a564c2dbfeb0e45cee0ab859e6eb0e6f8bb4. Merged origin/master first (already up to date, no conflicts). Implemented save-then-run and Duplicate, localized in en/zh/ja, with 17 regression tests. Changes confined to TodoView.js, i18n/index.js and todo-actions.test.mjs; no forbidden paths changed.

Installed: console project dependencies with `pnpm install`; pnpm 12.3.4 automatically downloaded when `pnpm test` ran under isolated HOME. No sudo or other tools installed; retry installed nothing.

Tests: required `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed with throwaway absolute HOME and runtime environment variables removed from test processes. Manager independently verified it. `pnpm build` passed (large-chunk warning). `pnpm test` after retry: 320 passed, 2 failed out of 322; local origin/master 172bd18d snapshot: 303 passed, same 2 failed out of 305. These pre-existing failures were not changed on this branch.
Failing test: `reasoning expands into the existing Markdown chat bubble`; `Skills sits after TODO in the navigation`.

Coder reports Chromium mocked-API smoke checks passed. UI was not visually inspected with screenshots; real-backend integration was not checked. Review should check the TODO interactions and note the two baseline failures.

Moved new/ → review/, round 1.
