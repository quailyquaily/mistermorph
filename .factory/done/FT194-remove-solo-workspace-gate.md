---
branch: factory/FT194-remove-solo-workspace-gate
round: 1
---
# Remove redundant Solo work-thread workspace approval

## factory · 2026-11-27 08:10
Owner request, quoted verbatim: “没必要审批 cc ，加到 factory new/”

Context: the preceding read-only Claude Code investigation concerned Solo work threads requiring the owner to open the child topic and approve the first command in a different workspace. Treat this item as removing that redundant workspace gate for Solo-dispatched work, not as a blanket request to disable Claude Code permissions or all tool approvals.

### Requested behavior
- Solo dispatching a task to an explicitly selected workspace is sufficient authorization to use that workspace for that task. Do not ask for a second workspace approval in the child topic before its first bash/write_file/coder/spawn or other currently gated tool.
- Repeated dispatches, resumed runs and new work threads should not create workspace-gate approval requests merely because their selected workspace differs from Solo's own workspace. Such tasks must not be canceled by the redundant gate's five-minute approval expiry.
- Preserve the selected workspace, normal path validation, workspace availability/access checks, tool-specific Guard policies, explicit administrator/root approval and coder-native permission settings. Do not broaden filesystem access or globally bypass approvals.
- Explicit workspace-switch requests outside this Solo dispatch case retain their existing authorization behavior. Do not turn dispatch into permanent authorization for unrelated workspaces or future unrelated tasks.
- Remove or update Solo-specific instructions and UI/documentation claims that require opening a work thread to authorize its selected workspace. Do not add remembered-authorization settings or a new Solo approval UI for the gate being removed.

### Investigation evidence to verify against the implementation base
Prior read-only investigation used origin/master be3c9308, not the running binary. Candidate locations: cmd/mistermorph/consolecmd/solo.go (Solo dispatch setup); agent/workspace_gate.go and agent/engine_loop.go (forced workspace gate); internal/pathroots/switch.go (workspace switching); docs/console.md and internal/ownertools/threads.go (approval instructions). tools.bash.confirm was reported removed and unrelated. Recheck these facts on the build base; do not rely on stale line numbers.

### Acceptance checks
- Dispatch from Solo workspace A to selected workspace B and invoke the first gated tool: no redundant workspace approval is created; tool executes in B subject to the remaining policies.
- Cover new run, repeated dispatch, resumed run, same-workspace dispatch and a child workspace path. No workspace-gate expiry is scheduled for these cases.
- Negative regression tests demonstrate that an unrelated workspace switch and independent Guard/coder permission requests still require their existing approvals; invalid or unauthorized workspace paths remain rejected.
- Update affected tests and English documentation. Run repository-required checks; if UI changes are necessary, include Console checks/tests and state whether the UI was actually inspected.

Scope: create this factory item only now; implementation follows the normal build/review/ship process.

## factory · plan · 2026-11-27 09:10

Behaviour: A Solo work_thread starts in its selected, validated workspace as its own authorized run workspace, regardless of Solo's workspace. Its first gated tool needs no extra workspace-switch approval; ordinary Guard, root and coder-native approvals still apply. Repeat, new, resumed, same-workspace and child-directory cases behave alike. Explicit later workspace_use into unrelated directories keeps the normal per-run approval. Invalid, inaccessible or unauthorized selections still fail before execution.
Scope: Solo dispatch workspace setup and focused regression tests; update tool instructions and English docs that describe the removed gate. Leave global engine/Guard policy, path validation, native coder permissions and UI unchanged unless strictly necessary.
Decisions: Use the selected workspace as the run's original workspace via the existing normal WorkspaceSwitch constructor; no persistent authorization or new config. Inspect resume state handling and retain genuine explicit-switch pending approvals. Do not indiscriminately clear stored approval requests. Avoid unrelated removal/refactoring of shared APIs.
Checking: Tests for cross-workspace dispatch, same/child workspace, continuation and resume, all currently gated tools, absence of workspace expiry/pending gate; negative tests for unrelated explicit switches, Guard/native permission independence and invalid/unauthorized selections. Run configured formatting/vet/full Go suite. No UI changes planned; no visual inspection planned.

## factory · 2026-11-27 09:10

Built commit: 269eaefd (base 289c27b3). Solo work threads now start with the normal per-run WorkspaceSwitch in their selected validated workspace. Removed Solo-only pending-original constructor/field after confirming no other callers. Explicit switches to unrelated workspaces retain their approval gate; Guard, admin/root and coder-native policies and selection validation are unchanged. No config or UI changes. Updated English Console/tools docs and work_thread instructions.

Checks: coder and manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`. Added engine and real-runtime coverage for new/continued/repeated threads, same/different/child workspaces, explicit-switch approve/deny and Guard approvals; existing tests cover rejected selections. Engine resume coverage passes.

Not checked: coder-native and root/admin prompts end to end; real powershell/coder/spawn/image execution (stand-ins cover their gate); an upgrade with an already-pending old workspace approval. Such old pending approvals are intentionally not silently cleared. No visual UI inspection; no Console sources changed, so Console checks were not required.

Installs: none. Coder reported one agent-memory note outside the worktree/TMPDIR (not part of the plan; exact location not reported). Manager observed no new directly-owned /tmp paths during coder or verification. Initial push needed a command-local credential.useHttpPath=true retry, which succeeded. No base branch or tag pushed.

## factory · review · 2026-11-27 09:15
head: 269eaefde9c4718c1f63570874fbf2218cabb448
verdict: pass
notes:
- Claude Code reviewed all 10 changed files in origin/master...HEAD against the request and plan; no P0-P3 findings. Traced selection validation, explicit workspace switching, Guard decisions, dispatch/topic authorization and resume handling. No widening of workspace authority found.
- Required check passed: `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` (172 packages passed, 19 without tests). New runtime tests fail against base and pass on head, confirming they detect the removed gate.
- Engine-level migration probe: a pending approval generated on base resumes on head; approval permits the write without a new gate, denial prevents it. Existing pre-upgrade pending approvals are not silently discarded and can still expire once.
- Residual risks: native coder/root prompts were read but not exercised live; powershell/coder/spawn/image tools use gate stand-ins. Migration was not exercised through a file-backed Console approval store/restart/expiry. No UI sources changed or visual inspection performed.
- Installs: none. Worktree stayed clean and head unchanged. Coder harness reported a background output file outside dir under /tmp/claude-995; tracked in the run's outside list, not deleted. No new directly-owned /tmp entry observed by the manager.

## factory · 2026-11-27 10:44
Shipped on the owner's word ("merge the ready items, no new tag"). Merged into master as c7515fad. It conflicted with master in cmd/mistermorph/consolecmd/solo_test.go (the Solo test harness constructors); the coder resolved it in the merge commit with one shared body, `startSoloHarness`, behind `newSoloHarnessAt` and `newSoloHarnessWith`. The repository's test passed on the merged master. No tag was made, as the owner asked. No linked issue or PR to close. The branch was not deleted.
