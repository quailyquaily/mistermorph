---
branch: factory/FT196-remove-workspace-use-gate
round: 1
---
# Remove the workspace_use first-write approval gate and its prompt claims

## factory · 2026-11-28 12:23
Follow-up to FT194 (done/FT194-remove-solo-workspace-gate.md, shipped as master c7515fad). FT194 stays done and its record and conclusions are unchanged. This item changes one FT194 decision: FT194's plan kept "the normal per-run approval" for explicit later workspace_use switches. The owner now wants that gate removed too.

Owner request, quoted verbatim: “internal/ownertools/threads.go:74 后半部分的可能审批的表述可以去掉。
cmd/mistermorph/consolecmd/owner_tools.go:77 这门也应该取消。
本需求和 cc 自己的审批无关，所以不需要考虑 cc 自己的审批。”

### Requested behavior
- `internal/ownertools/threads.go` (owner-cited line 74, the work_thread tool description): remove the latter half, the reminder that other approvals may still happen in the thread. Keep an accurate statement that the selected workspace needs no further approval.
- `cmd/mistermorph/consolecmd/owner_tools.go` (owner-cited line 77, ownerToolsPromptBlock): remove the application-level approval gate this text describes, where the first write or command after workspace_use switches the task to another directory asks the user. Remove the gate itself in the engine/workspace-switch code, not just the wording. Then update the prompt block, tool descriptions/instructions, English docs and tests to match.
- This covers owner runs that can call workspace_use, including the owner's Console chat and Solo work threads. If the same gate also serves other runtimes, the plan must say which ones exist and whether each is changed. Do not silently widen or narrow the scope.
- Claude Code's own permission approvals are entirely out of scope. Do not change them, and do not treat them as a blocker or as an acceptance condition.
- Keep every unrelated safety mechanism: workspace_use path validation and allowed-root/known-workspace rules, workspace availability/access checks, tool-specific Guard policies, explicit administrator/root approval, and coder-native permission settings. Do not broaden filesystem access beyond what workspace_use already accepts. Do not add remembered-authorization settings or a new approval UI.
- Existing pending approvals of the removed kind left by an upgrade must not be silently discarded. Resolve them sensibly and record the choice in the plan.

### Evidence to recheck on the implementation base
This board clone's origin/master is 289c27b3, before FT194, and the FT194 commits are not available locally. On 289c27b3, threads.go:74 reads "The first write or command in a workspace other than Solo's asks the user to approve, in the thread." and owner_tools.go:77 ends "...and the first write or command there asks the user." FT194 changed the threads.go wording. Recheck both locations and the line numbers on current master. Likely gate locations from FT194: agent/workspace_gate.go, agent/engine_loop.go, internal/pathroots/switch.go, cmd/mistermorph/consolecmd/solo.go, docs/console.md.

### Acceptance checks
- Solo work thread in its initially selected workspace: the first write and the first command trigger no workspace application-level approval. This must not regress from FT194.
- workspace_use in the middle of a run, both in a Solo work thread and in an owner Console chat, switching to a different valid directory: the next write and command (bash/write_file and the other tools the gate used to cover) run with no workspace-gate approval and no expiry. They still run in the new directory.
- Regression tests cover both cases. Replace or invert FT194's tests that asserted explicit switches still require approval, so the new tests fail on the pre-change code.
- Negative tests: invalid, inaccessible or disallowed workspace_use paths are still rejected. Guard, root/admin and coder-native approvals still fire independently.
- No prompt, tool description or doc still claims that this workspace approval happens: check the work_thread description, ownerToolsPromptBlock, the workspace_use tool text and docs/console.md.
- Run the repository's required check. Report what was verified end to end and what was only covered by tests.

Queue only now. Implementation, review and shipping follow the normal factory process.

## factory · plan · 2026-11-28 12:50
Behaviour:
- An owner Console run or Solo work thread starts in its selected workspace and writes/runs commands without workspace-only approval. workspace_use still validates/access-checks and enforces known/user-mentioned directories and denied roots. After a valid switch, all former gated tools execute in the current directory without workspace-only approval, including batched and codemode calls and repeated switches.
- Independent Guard decisions, forced/root/admin approval and coder-native permissions remain unchanged. Pauses for those approvals preserve the switched directory.
- Upgrade compatibility: retain existing pending requests and their normal explicit approve/reject/expiry lifecycle; do not silently approve, delete, or bypass stored pending requests. On approved resume, restore the directory and re-evaluate independent policies. Legacy approved-directory state may be accepted for decoding but never confers new access or imposes a gate. Document this policy and test legacy resume.
Scope:
- Remove workspace-only approval enforcement in engine and obsolete approval bookkeeping where compatible; update work_thread, workspace_use description/result, Console owner prompt, docs and regression tests.
- Workspace switches are wired in local_runtime.go for owner Console runs and Solo threads. The shared engine loses this specific gate for any embedding that supplies WorkspaceSwitch; ordinary channel/cron runtimes without workspace_use gain no new switching ability. Verify call sites and document any additional actual callers found.
- Do not alter path validation/access scope, independent Guard, administrator approval, coder permissions, unrelated UI or config.
Decisions:
- Keep active-workspace snapshot/restore for unrelated approvals. Preserve decode compatibility for old snapshots if fields are retired. No remembered-authorization settings or new UI. Repository AGENTS.md supersedes stale nsh version comment in factory rules if relevant; no Console TSX change expected.
Checking:
- Invert old explicit-switch approval expectations, cover every previously gated tool, batch/codemode execution, fresh thread and owner Console switches, correct destination, repeat switches without expiry and unrelated approval resume.
- Verify invalid/missing/inaccessible/disallowed or unknown paths remain rejected; independent Guard and forced/root cases still require approval. Do not exercise/change Claude Code native permissions.
- Run configured gofmt check, go vet ./..., go test ./.... No live LLM, interactive browser or privileged end-to-end scenario is planned: report tested versus untested explicitly.

Confirmed actual scope: the sole production switch creator is local_runtime.go ownerRun: owner Console chat, mistermorph chat, Solo topic and Solo work threads. Other channel, cron/TODO, Agent Link and fixed-directory tasks/subtasks remain unchanged and gain no switching.

## factory · 2026-11-28 12:50
Built and pushed ec41f49a. Removed workspace-only approval enforcement in the engine and obsolete Guard helpers/bookkeeping, preserving active-workspace snapshots and independent Guard/forced approvals. Updated work_thread and workspace_use text/results, owner Console prompt, docs/console.md and docs/tools.md. Path access validation and coder-native permissions are unchanged.

Existing pending approvals remain intact with explicit normal pending/approve/reject/expiry resolution. Approved resume restores the workspace, and legacy approved-list snapshots decode without conferring access. Automated tests cover these states.

Required check passed in both coder and independent manager runs: test -z "$(gofmt -l .)" && go vet ./... && go test ./... . Throwaway HOME/XDG/cache directories used. Coverage includes all seven formerly gated tools, repeated switches, batched and codemode calls, initial Solo workspace, owner Console and Solo switches using real write_file/bash with a fake model, refused paths, and independent Guard/forced approvals. New expectations were mutation-tested against pre-change code. No Console TSX changes; nsh checks not applicable.

Installs: none. No dependency manifest/lockfile changes.
Not checked live: interactive browser/LLM, actual coder/spawn, Windows PowerShell, or approvals written by the old binary (legacy records simulated in tests). Console end-to-end behavior is covered by the in-process runtime/HTTP harness, not a live interactive run.

Exception: coder reported automatic Claude project-memory writes outside the worktree/TMPDIR (FT196 note and FT194/index updates). No out-of-plan product changes committed. Manager did not change or delete those files. No new /tmp entries observed around coder/verification. Initial code push credential-path error resolved on the single retry with per-command credential.useHttpPath=true; no user git settings changed.
