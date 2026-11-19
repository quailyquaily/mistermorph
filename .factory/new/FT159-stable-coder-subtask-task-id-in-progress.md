# Keep coder subtask task_id stable in Progress while running

## factory · 2026-11-19 19:35
Owner reports a possible bug: when a task launches a coder, the subtask's `task_id` field in the Progress output repeatedly disappears and quickly reappears while the coder is running. Investigate and fix the flicker; the root cause is not yet confirmed.

### Reproduction and scope
- Launch a task that invokes a coder and watch its subtask entry in the Console Progress panel through successive running updates.
- Observe the `task_id` field intermittently disappearing and reappearing before the coder finishes.
- Trace the live update payloads, state merging and rendering to determine why the field becomes unstable; do not assume this is solely a CSS or rendering issue.

### Requirements and checking
- Once a subtask's `task_id` is known, keep it consistently visible for that same subtask through running updates and completion. Partial updates that omit the field must not accidentally erase a known ID.
- Preserve correct identity when multiple coder calls run concurrently or sequentially; never carry an ID into a different subtask or retain stale task state after a reset.
- Preserve existing progress content, status updates and interactions. Handle the interval before an ID is assigned without inventing a placeholder ID.
- Add regression coverage reproducing the confirmed cause, including successive partial updates, concurrent subtasks and completion. Verify the visible running-state behavior where possible and report checks that could not be performed.
