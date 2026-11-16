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
