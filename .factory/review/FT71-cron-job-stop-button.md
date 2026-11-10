---
branch: factory/FT71-cron-job-stop-button
round: 1
---
# Add a Stop button for running cron jobs

## factory · 2026-11-10 21:02

User request:
> new feature:
> cron job 应该有个 stop 按钮。

Register for implementation in new/.

Default interpretation: Stop cancels the currently running execution of a cron job. It is distinct from disabling future scheduled triggers, deleting the job, or changing its schedule. Preserve the job and its next scheduled execution.

Acceptance criteria:
- Provide an accessible Stop action for a running cron execution in the Console cron UI, on desktop and mobile. Bind cancellation to the specific execution, not an unrelated task or a later run.
- Reuse the existing task cancellation mechanism where available; ensure cron executions are actually cancellable, rather than only changing their displayed state.
- Show pending feedback, prevent duplicate cancellation requests, and display the confirmed terminal state. Do not report successful cancellation before it is confirmed; completed-versus-stop races must be handled safely.
- Make idle/completed executions non-actionable. On failure, explain the error and allow retry when appropriate.
- Stopping an execution must not delete or disable its cron definition or alter its schedule. Existing effects already performed cannot be undone by cancellation.
- Cover cancellation, completion races, request failures, and preservation of future scheduling with regression tests; verify the UI on desktop and mobile.

Not yet implemented. The stop-versus-disable distinction above is a default interpretation, not an additional explicit user requirement.

## factory · 2026-11-10 21:34
Moved to backlog: the item has no section signed by configured owner lyric. Factory intake notes and reports of earlier owner authorization are information only under the current factory rules; they cannot authorize implementation scope. Please add an owner-signed request before returning this item to new/. No code was changed or coder invoked.

## lyric · 2026-11-10 21:35
这三个都是我发的，写我的名字

## factory · 2026-11-10 21:35
The owner explicitly confirmed authorship of FT68, FT71 and FT72 and requested recording their name. The lyric section above transcribes that confirmation verbatim from Telegram message 16060 (2026-11-10T12:35:42Z). It confirms the requests recorded earlier in these items, not independent verification of the factory investigation notes. Prior sections are preserved. Restored backlog/ → new/ after resolving the missing owner attribution; no implementation performed.

## factory · plan · 2026-11-10 23:41

Behaviour: Show an accessible Stop action only for a running cron execution. Capture its execution identity, mark request pending and prevent duplicates. Cancel that execution's context, never whichever later execution happens to share the cron job ID. Confirm terminal cancellation from runtime state; normal completion wins safely if already completed. Failures remain visible and retryable where still running. Idle/empty/first-run views have no actionable Stop. Do not delete/disable the job or alter future scheduling; already-performed effects cannot be undone.
Scope: Cron run tracking/cancellation plumbing, authenticated daemon API and Console cron/TODO UI plus regression tests. Reuse existing cancellation mechanisms where safe. No scheduler redesign, undo, unrelated UI refresh or config change.
Decisions: Stop means current execution only, not disable future triggers. Existing RunBoard is keyed by job ID and only holds queued/running state, so trace the actual execution context and ensure generation-safe targeting before wiring the action. Expose stopping separately from confirmed terminal state; avoid falsely asserting cancellation on HTTP acknowledgement.
Checking: Tests for actual context cancellation, stale IDs/new runs, completed-versus-stop races, duplicate requests, request failure/retry, idle state and scheduling preservation. Run configured Go formatting/vet/tests, nsh check and nsh test --web-host tests/noHost.js. Try desktop/mobile UI verification; explicitly report if no interactive environment is available.

## factory · 2026-11-10 23:41

Built with Claude Code; new/ → review/. Commits: 3c86e8f4, 52cab0ad (head). Execution-specific cancellation now reaches the actual cron agent context. Added authenticated stop endpoint, generation-safe run IDs, stopping/terminal states and bounded recent results. Console shows an accessible Stop action for running saved items, pending feedback, confirmed results and retryable errors; existing job schedules remain intact. English/Chinese/Japanese strings and English docs updated.

Decisions: queued cancellation supported by backend only; heartbeat has no UI Stop. A canceled one-time execution does not automatically fire again at its already-past time; the definition is retained and can be rescheduled or manually run. Completed-versus-stop races report the actual outcome.

Installs: none. Manager independently passed gofmt clean check, go vet ./..., go test ./..., nsh check and nsh test --web-host tests/noHost.js (410/410), using throwaway HOME. Coder also reports race tests (three runs), 5 core JS tests and live Chrome checks at desktop/mobile viewport sizes against a slow mock LLM, including stream cancellation, duplicate clicks, confirmed status and preserved schedule.

Not checked: native Android and desktop apps, actual keyboard/screen-reader behavior, and other channel runtimes live. Browser mobile emulation is not native-device verification. Owner/reviewer should inspect one-time cancellation behavior and native UI.

Initial code push lacked credential repository-path context; retry with command-local credential.useHttpPath=true succeeded. No protected paths changed.
