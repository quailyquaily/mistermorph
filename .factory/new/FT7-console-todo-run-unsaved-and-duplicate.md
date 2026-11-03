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
