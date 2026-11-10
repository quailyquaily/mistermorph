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
