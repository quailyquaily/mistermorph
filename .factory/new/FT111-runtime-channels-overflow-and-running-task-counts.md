# Runtime channels: contain configuration details and show running task counts

## factory · 2026-11-14 06:52
Owner request from Console:

> When clicking the Not configured in the runtime -> channels, the section frame is overflowing.
> And I think it's also a good place to see how many tasks are running in each channel. So the console and the cli runtime should also be included as well. Add to new/

### Required behavior
- Fix the overflow in Runtime → Channels when clicking **Not configured**. Keep the resulting details or configuration guidance within the section and viewport, without content covering the frame or introducing unintended horizontal scrolling. Investigate the cause rather than assuming a particular CSS fix.
- Show the number of currently running tasks for each channel/runtime entry in this section. Include **Console** and **CLI** alongside the existing channel entries, even though these are not messaging-platform channels.
- Use actual runtime task state, not queued-task counts, total historical tasks, or guessed values. Define and consistently apply which execution states count as running; do not double-count a task across entries.
- Refresh counts with the existing runtime status update mechanism so task starts and completion, failure, or cancellation are reflected without a page reload. Show zero for an available entry with no running tasks; distinguish unavailable/unknown data from zero.
- Preserve configuration status and existing configuration actions for messaging channels. Console/CLI entries must not misleadingly require messaging-channel configuration.

### Acceptance checks
- Click Not configured for the applicable channel entries; verify details stay inside the section on desktop and narrow/mobile viewports, including long guidance text or identifiers. Opening and closing details must not break neighboring entries.
- Verify Console and CLI appear alongside existing channels, with accurate per-entry counts for zero, one, and multiple concurrent tasks.
- Start and finish/fail/cancel tasks and verify counts update; verify queued and completed tasks are excluded and unavailable status is not presented as a known zero.
- Add regression coverage for task attribution/counting and relevant UI rendering/layout. Check keyboard access and visible focus for configuration/detail controls. State any browser or live-runtime checks that could not be performed.

Status: requested only; no implementation or cause diagnosis yet.
