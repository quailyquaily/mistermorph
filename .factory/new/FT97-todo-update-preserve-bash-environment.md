---
branch: factory/FT97-todo-update-preserve-bash-environment
round: 2
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

## factory · review · 2026-11-12 16:07
head: 629e199f077937af18dbda9ef242b500296dd2ba
verdict: fix
fix:
- [P1] agent/engine_helpers.go:292: Bash Environment credentials bypass redaction when todo_update is invoked through codemode: the outer code string is returned unchanged and reaches tool_start/tool_done Args and, with include_tool_params enabled, tool_call_params logs. Redact the outer script arguments safely or exclude this sensitive tool from code mode, and cover that path with an integration regression test. Verified example: a codemode script calling todo_update(action=update, id=weekly-report, bash_env=[{name:API_TOKEN,value:synthetic-secret-value-0099}]) exposes the synthetic value in outer events/logs although inner todo_update arguments are redacted.
notes:
- [P3] docs/tools.md:287: English todo_update reference still lists only add_once/add_recurring/delete and omits bash_env, partial-update/clear semantics and redacted result shape; align it with the updated tool and vitepress documentation.
- Claude Code reviewed all 14 changed files on origin/master...HEAD and verified the code-mode leak with a synthetic-value integration probe. Manager classifies that finding P1 (coder suggested P2): code mode is enabled by default and the newly accepted credential values are exposed in ordinary tool events, violating the explicit no-disclosure requirement. No actual user secrets or live tasks used.
- Validation: manager independently ran test -z "$(gofmt -l .)" && go vet ./... && go test ./... with throwaway HOME; all passed. Coder's initial test run failed without identifying a package due to truncated output; subsequent full and uncached runs passed. Initial failure cause remains unknown, not proven unrelated.
- Installs: none. Source worktree remains clean; no UI changes, visual checks or nsh checks. Live-model compliance not checked. Run state/transcripts/approval persistence still retain values by design; unknown update parameters are ignored. Coder reported using a temporary scratch copy outside the assigned run directory for its probe and deleting it; that location did not comply with the run-directory rule.
- Round 1 of 3: returned to new/ for the next build to fix the P1 before shipping. No linked GitHub issue or PR identified. Not merged or released.

## factory · plan · 2026-11-12 16:31

Fix round 2 addendum:
- Fix the latest review P1 by withholding outer codemode script source from event arguments and parameter logs, including dynamically constructed values; preserve actual execution and nested todo_update redaction. Do not rely on JavaScript source regexes.
- Cover real engine dispatch, persistence/reload, literal/computed synthetic credentials, failed inner calls and malformed scripts. Align docs/tools.md with update, bash_env clearing and redacted results (related P3).

## factory · 2026-11-12 16:31

Fix round 2 built and pushed at 0769aaa3 (commits 7e65c709 and 0769aaa3). Moved new/ → review/.
- Fixed P1: codemode parameters in tool_start/tool_done arguments and include_tool_params logs now contain only a withheld marker and script size. Original execution arguments are untouched; nested todo_update calls keep their own redaction. Whole-source withholding avoids leaks from computed expressions and malformed scripts, at the cost of no script source in ordinary activity/log views.
- Added unit and integration regressions: real codemode dispatch with literal/computed synthetic values, unknown ID and invalid environment failures followed by successful update, persistence/reload and unrelated-field preservation, malformed script, outer/nested events and parameter logs. Coder reports the regression fails when this fix is reverted.
- Updated English docs/tools.md for update, omission/clear/null semantics, bash_env, schedule-kind changes, result redaction and script-source withholding (P3).
- Validation: coder and manager independently passed test -z "$(gofmt -l .)" && go vet ./... && go test ./... using throwaway HOME under the build directory. Coder's initial formatting failure was fixed before the passing run. Worktree clean, only item-related history, no protected paths changed.
- Installs: none; no dependency changes. No merge needed because origin/master remains an ancestor.
- Not checked: live-model prompt compliance. No UI sources changed; no visual inspection or nsh checks. Conversation/run state still retain script source by design; arbitrary script output/returned text/thrown error text is not automatically scrubbed. No live tasks or user credentials touched.
- Manager's first verification command was blocked by a local path guard; the replacement checked the full changed-path list and passed the same test gate.
Next: review the security fix and its intentional observability tradeoff. Not merged or released.

## factory · review · 2026-11-12 16:52
head: 0769aaa3e6fe2cb3a36d6a86debef5180bb4aad5
verdict: fix
fix:
- [P1] agent/engine_helpers.go:293: tool parameter redaction covers events/logs but not the raw ToolCall hooks consumed by chatcmd/tui_activity.go:155,165. Direct and nested todo_update calls print bash_env credential values in the chat activity and persistent terminal transcript, and outer codemode calls print the script source. Apply shared display redaction to both chat formatters (without altering execution parameters) and add direct/nested/codemode regression coverage. Verified synthetic API_TOKEN value synthetic-secret-value-0777 appears in both activity and transcript in all three cases.
notes:
- Claude Code reviewed all 16 changed files on origin/master...HEAD. The previous outer-codemode event/log P1 and English docs P3 are fixed. No other findings reported. Manager classifies the newly verified CLI disclosure as P1 rather than coder P2: this is the same newly accepted credential material exposed through ordinary tool display, contrary to the explicit no-disclosure requirement; it is not deliberate internal run-state retention.
- Probe used a temporary detached worktree under the review run directory and synthetic credentials only; the probe copy is retained in the run artifacts. Coder removed the temporary worktree and left the source worktree clean. Manager inspected the raw ToolCall hook consumers and confirmed both display formatters bypass redaction.
- Validation: coder and manager independently passed test -z "$(gofmt -l .)" && go vet ./... && go test ./... with absolute throwaway HOME/TMPDIR under the review run directory. Coder's initial GOFLAGS-modified attempt was stopped and rerun without that override; the completed gate passed. No protected paths changed; only item-related history.
- Installs: none. No UI sources changed; no visual inspection or nsh checks. Live-model guidance compliance not checked. Arbitrary codemode output/error text, conversation/run state and debug LLM request dumps remain outside ordinary argument redaction; syntax-error source quoting was not separately verified. Unknown update parameters remain silently ignored.
- Round 2 of 3: returned to new/ for the next fix round. No linked GitHub issue or PR identified. Not merged or released.
