---
branch: factory/FT159-stable-coder-subtask-task-id-in-progress
round: 1
---
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

## factory · plan · 2026-11-19 20:16

Behaviour: Trace coder live progress producers, update storage/merging and Console normalization/rendering to establish the actual cause. Before assignment show no invented ID; after assignment keep the known task_id on the same activity through partial running updates and completion. Keep unrelated content/status/interactions current. Independent concurrent/sequential activities and reset must not inherit another ID.
Scope: Only the confirmed progress identity bug and regression tests. No process reaping, general UI redesign or unrelated cleanup.
Decisions: Prefer preserving identity at the authoritative merge point with stable activity keys, not a global UI fallback. Treat absent/empty ID according to actual producer semantics; reset/new activity clears identity. Select minimal fix after tracing, document the confirmed cause.
Checking: Add regressions covering reproducing updates, omitted fields, multiple activities, completion and reset/new calls. Run configured Go checks and, when Console sources change, nsh check and scripts/test.sh. Attempt visible running-state verification with available tools; explicitly report if not possible.

## factory · 2026-11-19 20:16
Built in commits 92f4de83 and 3d4698ce; pushed head 3d4698ce.

Confirmed cause: running polls contain no activity, so the Console re-normalizes retained stream activity. The normalizer read snake_case task_id but not its own camelCase taskId, dropping the ID until the next stream frame. The server retains IDs correctly.

Implemented idempotent normalization for per-entry taskId, outputKind, childrenOmitted and shell results. No shared/global ID fallback; independent activities and later tasks keep their own identity. Added core, Console interaction and Go server regression tests for repeated partial updates, concurrent calls, pre-assignment, completion and following tasks.

Checks: configured gofmt/vet/go test gate passed independently by manager. First manager attempt used an unclean TMPDIR containing a parent segment, triggering unrelated path-string assertions; rerunning with canonical TMPDIR passed without code changes. Coder reports nsh 0.6.0 check passed; required scripts/test.sh passed all 146 files (one unrelated drag test passed its automatic solo retry); node core tests passed.

Visual running-state check: coder used real headless Chrome with simulated stream/poll traffic; old code lost IDs in 144/247 samples, fixed code in 0/247, completion retained both IDs. Browser probe used available nsh 0.5.1 web runtime, not 0.6.0. A real coder-backed UI session, desktop and Android visual checks were not performed.

Installs: none. No manifest/lockfile changes. Owner should inspect the normalization fix and running-state regression tests during review.

## factory · review · 2026-11-19 20:30
head: 3d4698ce4fee75525c24a5020e338bccbf7248fa
verdict: pass
notes:
- No P0, P1, P2 or P3 findings. Claude Code reviewed all four changed files against origin/master...HEAD; confirmed activity-less polls re-normalize camelCase entries and the fix preserves each entry identity without cross-subtask carryover.
- Validation: configured gofmt/vet/go test gate passed (exit 0); nsh 0.6.0 check passed; required Console scripts/test.sh passed 146 files, 0 failed, no retries; Node core tests passed 282 tests. New core regressions fail against base (22 pass, 2 fail); new polling UI regression fails against base with missing sub_a/sub_b IDs. Worktree unchanged.
- Installs: none. No real coder-backed session, desktop or Android visual verification; no JDK for Android JVM checks. Browser sample figures from build were not independently reproduced; stream/poll interleaving is covered through activity-bearing and activity-less polls, not live WebSocket traffic.

## factory · 2026-11-20 10:25
Shipped: merged into master as 72e77ea6b57a085c6c793b133586f07824958d77, tagged v0.3.122 and pushed. No linked GitHub issues or PRs to close. Branch kept (the ship does not delete branches here).
