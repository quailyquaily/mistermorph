# Fix todo_update losing configured Bash Environment when editing tasks

## factory · 2026-11-12 15:39
Owner request (translated from Chinese):
> Add this as a new fix in the factory, written in English.

Problem:
Updating a scheduled task's description through `todo_update` can clear its existing Bash Environment. The tool currently offers no Bash Environment field and no dedicated update action, encouraging delete-and-recreate edits that cannot preserve all existing settings. Inspection of `internal/cron/store.go` also shows that `AddOnce` and `AddRecurring` reconstruct a Task without copying `BashEnv`, dropping it even when supplied by a caller. Verify the full tool-to-storage path against the current base before implementing; do not assume this is the only affected path.

Requirements and acceptance criteria:
- Add a supported, ID-based partial update operation to `todo_update`, backed by the existing scheduled-task storage abstraction. Editing a task must not require deleting and recreating it.
- Preserve every omitted field, including Bash Environment, workspace, schedule, timezone, destination, title, and other persisted task settings. Keep the task ID stable. Explicit empty values must be distinguishable from omitted fields; provide and document a deliberate way to clear Bash Environment without interpreting omission as clearing.
- Expose Bash Environment through the tool using the existing task representation and validation rules. Preserve it on both one-time and recurring task creation, including the `AddOnce` and `AddRecurring` storage paths. Do not introduce a separate incompatible environment format.
- Make partial updates atomic using the existing mutation/transaction mechanism. Reject unknown task IDs and invalid updates without deleting or partially modifying the original task. Preserve existing behavior of add and delete operations.
- Update the tool schema, tool help, and agent-facing scheduling instructions so description edits use partial updates rather than delete-and-recreate. Keep documentation in English.
- Treat environment values as potentially sensitive: do not expose them in logs, errors, or ordinary mutation summaries. Use synthetic values in tests and documentation.

Regression coverage:
- For both one-time and recurring tasks, changing only the description/content preserves a preconfigured Bash Environment and all unrelated settings through persistence and reload.
- Creating either task type with Bash Environment preserves it through storage and reload.
- Explicitly setting, replacing, and clearing Bash Environment works, while omission leaves it untouched.
- Unknown IDs, invalid environment values, and invalid schedule updates fail without changing the stored task.
- Exercise the actual tool dispatch/schema and persistence boundary, not only a helper. Cover both SQLite and any supported legacy file-store path affected by the change.

Scope: scheduled-task creation and safe partial edits, with particular attention to Bash Environment data loss. Do not modify live scheduled tasks, user environment values, or unrelated scheduler behavior. This entry requests a future factory build, not implementation or release during intake.
