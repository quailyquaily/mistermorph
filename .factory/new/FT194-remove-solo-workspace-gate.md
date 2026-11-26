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
