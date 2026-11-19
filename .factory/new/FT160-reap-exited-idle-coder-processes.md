# Reap exited idle coder processes after Console process Stop

## factory · 2026-11-19 19:38
The owner requests that the factory fix this bug through its normal build and review workflow. Do not deploy or ship outside that workflow.

### Observed behavior
- Claude CLI PID 4088310 was initially alive (`Ssl`). After the owner reports pressing the Console Stop button, it was observed as `Zs`, `[claude] <defunct>`.
- Its parent was the morph Console server, PID 3906177. The process had exited but its parent had not collected its exit status.
- The precise click-to-exit linkage was not captured. Investigate the per-process Stop action in the task Processes panel, distinct from stopping the whole task.
- Preliminary local investigation identified a likely lifecycle gap: an idle persistent coder process can exit between tasks without being waited on until the next session use or close.

### Required behavior
- Promptly reap an exited coder subprocess, including when it exits while its session is idle, without requiring another task, session closure, or server restart.
- Cover Console per-process Stop, unexpected exit/crash, normal completion and explicit session cleanup; preserve persistent-session reuse while the process remains alive.
- Coordinate process-group termination and waiting safely: no double wait, deadlock, goroutine leak, or signal sent to an unrelated process/group after PID reuse. Clean up remaining owned child processes where appropriate.
- Keep task cancellation, output/error reporting and subsequent session recovery correct. Check the shared subprocess lifecycle for other coder backends rather than assuming the issue is Claude-only.

### Candidate and verification
- `.factory/references/FT160/local-candidate.patch` preserves the uncommitted candidate from the earlier Claude Code investigation, including Linux regression tests. It is a starting point to inspect, not an approved implementation; independently reproduce the bug and review its concurrency/error paths.
- The candidate remains uncommitted in the owner's checkout. Build in the factory's own clean worktree from its configured base; do not edit, reset, or clean the owner's checkout or rely on those local modifications.
- Add a Linux regression test that reproduces an idle persistent subprocess exiting and verifies prompt reaping before another task or close. Include process-group cleanup and concurrent exit/close coverage as applicable.
- Run the configured repository checks and race-enabled tests for the affected lifecycle code. Confirm the regression fails without the fix. Exercise the Console process Stop path where feasible; explicitly record any manual checks not performed.
