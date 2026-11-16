---
branch: factory/FT135-cron-job-query-tool
round: 1
---
# Tool to query cron jobs, including enabled/disabled status

## factory · 2026-11-16 15:16

Owner request:
> A new tool to query cron job.
> It can query all, and the result should also include the enabled/disabled status.
> Add to new/

Requirements:
- Add an agent-callable, read-only tool to query cron jobs.
- Support listing all cron jobs within the caller's existing authorized scope, including both enabled and disabled jobs; do not silently filter out disabled jobs.
- Each returned job must include its identifier, useful identifying details and schedule, and an explicit enabled/disabled status.
- Use the scheduler's actual stored state rather than inferring enabled status from recent executions or next-run times.
- Follow existing tool conventions, access boundaries, and error handling. Querying must not create, update, enable, disable, or run jobs.
- Return a clear empty result when there are no jobs and report query failures rather than presenting them as an empty list.
- Add regression coverage for mixed enabled/disabled jobs, all-disabled jobs, no jobs, query failures, and unchanged state after querying.

This records the request only; implementation and final tool name are pending.

## factory · plan · 2026-11-16 15:24

Behaviour: Add a read-only `todo_list` tool with no required arguments. List all tasks in the runtime's existing authorized cron store, including disabled and one-time tasks. Return identifying details, schedule and an explicit enabled boolean from stored state; unset enabled means true. Empty state returns an empty array; read failures return errors. Follow existing database initialization conventions without changing or running jobs.

Scope: Built-in tool, registry and schema integration, prompt/docs and regression coverage. No UI, scheduler mutation API, caller-selected store path or expanded scope. Omit environment values.

Decisions: Use `todo_list`, align with `todo_update` terminology, and use the runtime's resolved cron path. A read-only listing does not need the mutation tool enabled. Prefer no new configuration. Include stored last-run details, not inferred status.

Checking: Cover mixed enabled/disabled jobs, all-disabled jobs, fresh/empty state, read failures, cancellation, unchanged persisted rows, environment redaction, registration and schema/prompt exposure. Run the configured formatting/vet/full Go tests with an absolute throwaway HOME.

## factory · 2026-11-16 15:24

Built and pushed `04df63c7` on `factory/FT135-cron-job-query-tool`. Added `todo_list` returning `count` and `tasks`, with explicit enabled flags, identifying details and stored schedule/status. Empty lists return `[]`; read failures are errors. Added context-aware store reads, static registration, schema catalog and prompt integration, Telegram activity status and English docs. No new config key; listing remains available with mutation disabled. Environment values are excluded; only variable names are returned. Caller cannot select a different store.

Installs: none.

Tests: configured `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed in Claude Code and independent manager verification with a throwaway HOME. Regression coverage includes mixed/all-disabled/empty/fresh stores, read failures, cancellation, unchanged persisted rows, environment redaction and registration/schema/prompt exposure. No protected paths changed; the only implementation commit is scoped to this item.

Not checked: live LLM/channel integration. No Console/UI sources changed; Console tests not required.

Push note: initial code push lacked repository-path credentials; retry with command-local credential.useHttpPath=true succeeded. No credential settings persisted.
## factory · review · 2026-11-16 15:50
head: 04df63c71f78a0535a9ee2e587550c2552d43a67
verdict: pass
notes:
- [P2] tools/builtin/todo_list.go:64: The tool ignores the runtime audience and returns the entire cron store to non-owner conversations, including tasks from other chats. Restrict non-owner calls to their authorized tasks or exclude the tool from non-owner registries; add audience regression tests. Verified example: a call under audience.Conversation("tg:-1009999") returned an owner Console task with its private reminder content, destination, workspace and environment variable names. The accepted runtime-store plan does not explicitly authorize cross-audience disclosure.

Validation: Claude Code reviewed origin/master...HEAD (base 0200398d, merge-base c611561e). Configured formatting, go vet and full go test gate passed with a throwaway HOME. An overlay-only audience probe reproduced the P2 finding; no tracked files changed. No P0/P1 findings, so pass under the factory review gate. No installs. Worktree clean, no protected paths changed. No Console sources changed.

Residual risks: live LLM/channel integration not exercised. Prompt workflow is absent when todo_update is disabled, and its opening wording still emphasizes mutation. First-use database initialization/import follows the existing store convention. Owner should assess the cross-audience disclosure note before shipping; this pass is not a claim of no defects.


## factory · 2026-11-16 23:53

Shipped with Claude Code. Merge commit: 75ac75cd; remote master verified at 75ac75cd065b8aec9f0359a989d2c92db103b24b. No tag created or pushed, per owner request. No merge conflicts or integration-fix commits.

Owner explicitly approved inclusion: "FT135 is fine to merge too". The documented cross-audience disclosure is accepted for this ship and remains unfixed.

Final combined gate passed at 75ac75cd: gofmt, go vet ./..., go test ./..., nsh check 0.5.1, required Console scripts/test.sh (130 files, zero failures, no retries), 281 Console Node tests and 24 Cloudflare Node tests. Earlier FT138/FT139 gates each required an isolated attachment-test retry; the final combined run did not. No unpinned installs. No fresh visual/browser, live model/channel, native platform checks or platform builds.

No linked GitHub issue or PR to close. Branch retained (clean not configured). Moved ready/ → done/.
