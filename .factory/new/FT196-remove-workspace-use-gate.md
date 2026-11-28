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
