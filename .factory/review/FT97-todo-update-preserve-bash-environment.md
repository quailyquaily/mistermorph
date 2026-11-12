---
branch: factory/FT97-todo-update-preserve-bash-environment
round: 1
---
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

## factory · plan · 2026-11-12 15:54

Behaviour:
- Add once/recurring with optional bash_env in the existing [{name,value}] representation; validate and persist without leaking values in summaries/errors.
- action=update requires an existing id and applies only supplied fields atomically. Omitted fields, ID and runtime metadata survive. Empty bash_env clears it; absent bash_env preserves it. Invalid types, invalid resulting schedules/environment and unknown IDs leave storage unchanged.
- Content-only edits use the exact supplied text (no delete/recreate, implicit destination/workspace defaults or unrelated semantic rewriting). Explicit values follow existing task validation; document how switching schedule kinds and clearing optional fields work.
Scope:
- Storage creation/update, actual tool dispatch/schema/help, scheduling guidance and regression tests for SQLite and supported legacy persistence/migration. No live tasks, UI changes or unrelated scheduler changes.
Decisions:
- Use a presence-aware patch (not a replacement Task) and the existing Store mutation transaction. Preserve metadata by modifying the stored task, validate the resulting definition before writing. Reject ambiguous/null field types rather than accidentally clearing.
- Reuse existing BashEnvRef and validation, redact environment values from all mutation tool output including add/delete. No new environment format or config keys.
Checking:
- Tests for both task kinds: create with environment; content-only edit preserves every unrelated field across reload; set/replace/clear/omit environment; unknown ID, invalid env/types/schedules unchanged. Exercise tool schema+dispatch, persistence, legacy path where supported, and sensitive-value non-disclosure.
- Full gate: test -z "$(gofmt -l .)" && go vet ./... && go test ./... with throwaway absolute HOME. No UI changes planned.

## factory · 2026-11-12 15:54

Built and pushed branch factory/FT97-todo-update-preserve-bash-environment at 629e199f (three focused commits from 416ed2d1).
- Added transactional Store.Update and presence-aware tool action=update; task ID, omitted definition fields and run metadata remain intact. AddOnce/AddRecurring now retain BashEnv.
- Existing [{name,value}] format; omission preserves, [] clears, supplied list replaces. Empty optional strings clear; title resets to default. Setting at alone switches to one-time, cron alone to recurring; invalid resulting definitions are rejected atomically. Content edits bypass semantic name rewriting (surrounding whitespace is trimmed). Null/wrong-type patch fields and nonempty people are rejected.
- Updated schema/help, English scheduling guidance and docs. Mutation summaries expose only environment names; agent tool logs/events redact environment values.
- Coverage includes both task kinds, create/update/reload, all environment operations, invalid updates/unknown IDs, actual tool registry dispatch, SQLite and legacy YAML import, and end-to-end agent event/log redaction.
- Installs: none.
- Manager independently verified: gofmt clean; go vet ./... and go test ./... passed with throwaway HOME. No protected paths changed; history contains only this item.
- Not checked: live-model prompt compliance. No UI sources changed; no visual inspection or nsh checks needed. Translated docs not changed. Existing Console editor API and conversation/run state still retain environment values where required; no live tasks or user values were touched.
- Push credential helper initially required repository-path context; retry with command-local credential.useHttpPath=true succeeded. No persistent git configuration changed.
Next: review preservation/rollback semantics and redaction coverage before shipping. Not merged or released.
