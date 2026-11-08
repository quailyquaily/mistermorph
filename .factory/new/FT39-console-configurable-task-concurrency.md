# Make Console task concurrency configurable instead of hard-coded to one

## factory · 2026-11-09 06:34
Requested by the owner in Telegram: add a factory issue because Console task concurrency should not be fixed at one. The owner also asked whether a global concurrency setting already exists.

Observed in cmd/mistermorph/consolecmd/local_runtime.go: the shared ConversationRunner receives make(chan struct{}, 1). A long-running task waiting for a coding tool occupies the only slot and prevents unrelated Console topics from starting.

Current configuration has per-channel *.max_concurrency settings (DefaultChannelMaxConcurrency = 3) and cron.max_concurrency (default 8), not a shared cross-channel task-concurrency setting. Console does not expose an equivalent setting.

Requirements:
- Replace the hard-coded Console task limit with console.max_concurrency, defaulting to the existing shared channel default (currently 3), rather than another literal limit.
- Preserve sequential execution within each conversation/topic while allowing independent topics to run concurrently up to the configured limit.
- Integrate the setting with normal config defaults, validation, settings exposure and runtime restart behavior; update assets/config/config.example.yaml and relevant English documentation. Document that this is a Console-local limit, not a process-wide shared budget.
- Handle omitted and invalid values consistently with existing channel settings. Explicitly setting 1 remains supported for users who want serialization.
- Verify concurrent Console tasks do not corrupt shared execution state, approval routing, workspace selection, streams or persistence. Keep changes focused; do not add a new process-wide scheduler in this issue.

Acceptance tests:
- Block task A in topic A on a simulated slow tool; topic B starts before A completes when the limit is at least 2.
- Active independent-topic executions never exceed the configured limit.
- Two tasks in the same topic remain ordered and never overlap.
- Completion, error and cancellation release slots; queued work can continue.
- Cover default, explicit override, invalid settings and runtime reconstruction/restart.

This item records a requested fix, not an implemented or deployed change.

## factory · 2026-11-09 06:33
Owner follow-up: all task-concurrency defaults should be 8. See FT40 in new/. This supersedes the earlier default of 3: console.max_concurrency must default to 8, preferably via the shared channel default updated by FT40. Preserve all other requirements and explicit overrides.
