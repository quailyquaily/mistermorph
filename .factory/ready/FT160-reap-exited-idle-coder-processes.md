---
branch: factory/FT160-reap-exited-idle-coder-processes
round: 1
---
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

## factory · plan · 2026-11-19 20:39

Behaviour
- Keep live persistent coder processes reusable; promptly reap idle/active exits from Stop, crash or normal process completion independently of another task or close.
- Preserve buffered output, stderr diagnostics, cancellation and session recovery. Coordinate one wait with safe owned-group cleanup, including concurrent close/exit.
- Consider malformed output, full idle queues and inherited pipes rather than assuming stdout EOF is the only exit condition.
Scope
- Shared internal/codersessions lifecycle and focused regression tests; inspect Console backend per-process Stop integration. No unrelated UI changes or owner checkout modifications.
Decisions
- Independently reproduce and evaluate the candidate; use shared backend lifecycle ownership, respect exec.Cmd pipe/wait requirements, prevent signals after PID identity is released.
- Keep persistent sessions alive across normal tasks. Document platform limitations and unperformed live checks.
Checking
- Linux idle exit regression must fail before fix; test descendants, concurrent close/exit, buffered output, reuse/recovery and Stop backend where feasible.
- Run configured gofmt, go vet ./..., go test ./... and affected race tests. Scripted tests use an absolute throwaway HOME under TMPDIR.

## factory · 2026-11-19 20:39
Built 44cca346 on base 15f64beb. Shared lifecycle now observes process exit independently of stdout/consumer activity, cleans its owned process group before releasing PID identity, and waits exactly once. Linux uses waitid(WNOWAIT); BSD/macOS use kqueue; other platforms use safe process-handle fallback. Owned stdout preserves buffered messages and bounds inherited-pipe delays. Live sessions remain reusable; dead sessions reopen and retain exit/stderr errors.

Added Linux regressions for idle exits across backends, SIGTERM/SIGKILL, actual proctrack.Kill Stop backend (idle/active/child), inherited pipes, full queues, buffered output, concurrent close/reset and signal-before-reap safety. Thirteen regression cases failed on original base; candidate patch also failed key cases and was not used.

Checks: configured gofmt cleanliness, go vet ./..., go test ./... PASS (coder and independently manager); go test -race ./internal/codersessions PASS independently. Coder additionally passed repeated race/concurrency and related proctrack/taskruntime/agent tests. Cross-vet passed darwin/freebsd/openbsd/windows; other platform full checks were limited by sqlite dependency, with new files typechecked separately.

Installs: none. No Console sources changed. Not checked: live Console UI Stop against real CLIs; non-Linux runtime behavior (compile/type checks only). No deployment or ship. First branch push required a command-local credential.useHttpPath=true retry, which succeeded; no settings changed.


## factory · review · 2026-11-19 21:02
head: 44cca346b0b86229cb762dfd47b924578a9d9fe6
verdict: pass
notes:
- [P3] internal/codersessions/rpc.go:186-194: markExited closes stdout after a fixed 1s even while draining buffered output. Verified fake CLI emits 500 lines, result, exit 0 with Note delayed 5ms/line: head lost the result in 2/3 runs (notes=371, coder server exited with exit status 0); base delivered notes=499 and result bye without error. Bound idle read time rather than total drain time.
- [P3] internal/codersessions/rpc.go:206-207: before watch sets unwatched, non-Unix kill falls through to no-op killGroup, so immediate close/cancellation waits for natural process exit. Windows-stub probe on Linux with a 3s sleeper returned cancellation only after 3.004s; direct immediate close reproduced 5/5 single-core runs and 10/10 multicore runs. Initialize fallback mode before launching watch, or use Process.Kill on non-Unix. Native Windows runtime reproduction not performed.

Review scope: origin/master...44cca346; all 12 changed files and lifecycle callers. Claude Code review only; clean worktree, no code commits. No P0/P1 findings.
Validation by reviewer: gofmt cleanliness, go vet ./..., go test ./..., go test -race ./internal/codersessions, repeated race lifecycle tests, and race checks for proctrack/taskruntime PASS. Seven new regression tests failed on base in scratch reproduction. Cross-vet darwin/freebsd/openbsd/windows amd64/arm64 PASS; netbsd/dragonfly package vet blocked by sqlite dependency, isolated new-file type checks passed. Installs: none.
Limits: no live Console UI Stop against real CLIs; non-Linux runtime not exercised. Each live process uses an OS thread in blocking waitid/kevent. Passed under factory policy (no P0/P1), with the two verified low-priority defects above retained for owner review. No ship or deployment.
