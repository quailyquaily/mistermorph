---
branch: factory/FT156-hide-idle-task-processes-entry
round: 1
---
# Hide the task Processes entry when no process is running

## factory · 2026-11-19 14:41
Owner request from Console:

> For a task, if there is no process running, no need to show the processes entry.

### Requirements
- Show a task's Processes navigation/action entry only while that task has at least one running process. Completed or exited process records alone must not keep the entry visible.
- Use the existing process lifecycle/state source, including any existing states representing live processes; do not infer this from whether the task itself is running.
- Update visibility as processes start and exit, without requiring a page reload. Scope the check to the current task: processes belonging to other tasks must not affect it.
- Preserve existing process inspection and control behavior when the entry is visible. Do not delete process history or change process execution/retention behavior.
- If the Processes view is already open when the final process exits, handle this safely without a broken selection or dead navigation target, following existing Console navigation conventions.

### Acceptance / coverage
- No running process (including a task with only exited process records): no Processes entry.
- First process starts: entry appears; one of several exits: entry remains; final process exits: entry disappears.
- Verify task switching and live updates, and preserve access to controls for running processes.
- Add regression coverage using the existing Console component/test conventions.

## factory · plan · 2026-11-19 16:20
Behaviour: hide the Processes entry until the task-scoped process lifecycle source reports a live process. Show on first start; retain for running roots and live descendants/orphans, even after task completion; hide after the final exit. Refresh without reload, isolate tasks/endpoints, and safely close an open Processes panel when its last process exits. Empty, unknown, unsupported and failed reads do not claim live processes.

Scope: Console process reading, status entry, detail navigation and regression tests. No backend execution, process history or retention changes.

Decisions: share GET /tasks/{id}/processes readings between visible reply rows and the panel; poll every two seconds for running tasks/open panels, five seconds for finished replies. Dispose unobserved readings; ignore superseded responses. Use live roots/descendants/other processes, never tool history or task running alone. Unsupported systems stop polling. Close the ended panel after a successful empty read, not on network errors.

Checking: cover exited-only history, starts/exits, multiple processes, running controls, task/endpoint isolation, late/error/unsupported responses, shared reading cleanup and open-panel closure. Run repository Go checks, nsh check, and the required parallel Console suite; manual browser/device verification remains separate.

## factory · 2026-11-19 16:20
Built and pushed 1ef22f73: task-scoped shared process readings now control entry visibility; existing process tree and Stop use the same state. The panel closes when the final process exits and requests Progress focus after Stop where applicable. Added 12 process regression tests. No installs; no config or backend lifecycle changes.

Tests: coder ran `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`, `nsh check`, and `web/console-nsh/scripts/test.sh`: all passed. Console suite: 142 files, zero final failures; six unrelated parallel failures passed the script's isolated reruns. Manager independently reran the required Go command, nsh check and the process file (12/12 passed). No forbidden paths changed; one item-specific commit based on 47232d75.

Not checked: no real browser/device visual inspection or real-process integration; headless stubs cannot verify keyboard focus return. Polling load with many visible replies was not measured. A failed read hides the entry until the next successful refresh. Initial push credential helper lacked the repository path; retry with command-local credential.useHttpPath=true succeeded.

## factory · review · 2026-11-19 16:31
head: 1ef22f731d08dac3646a0774f02a055082a91d08
verdict: pass
notes:
- [P2] web/console-nsh/components/chat/taskProcesses.ts:202-213: Replacing a streaming reply item reruns the watcher even when endpoint/task/fast are unchanged; remove/add resets fastWatchers to one and schedules an immediate read, bypassing the two-second interval. Re-subscribe only when the actual watch tuple changes, and add regression coverage. Verified store probe: 20 item replacements with fast=true caused reads to increase from 1 to 21; fast=false remained at 1. App probe: eight 1.2-second task polls caused eight process reads. Each backend read can scan the user's process tree, so stream-frame-rate polling creates avoidable load.

Validation: Claude Code reviewed origin/master...HEAD (eight files), request and plan, live lifecycle classification, task/endpoint isolation, stale response handling, disposal, panel closure, controls and relevant backend/security boundaries. Required Go gate passed (165 packages); nsh check passed; required parallel Console suite passed (142 files, zero final failures). Two unrelated parallel failures passed isolated retries. Head unchanged; worktree clean. No installs.

Not checked: real browser/device panel focus, actual WebSocket frame rate/server load, and aggregate five-second polling load across many completed replies. The accepted transient-error behavior hides the entry until a successful read. No P0/P1 findings; moved to ready/ under the factory review policy. The P2 polling defect remains for owner attention before shipping.


## factory · 2026-11-19 17:51
Shipped with Claude Code on owner approval. Merge: 15f64beb59481f83116be3f085ab71bfa70e9aae; release: v0.3.121; verified remote master and peeled tag: 15f64beb59481f83116be3f085ab71bfa70e9aae. Clean no-ff merge, no fixes or installs.

Validation: gofmt/vet/go test passed (165 packages ok); nsh check passed; required parallel Console runner 145/145 files, zero retries; Console Node 295/295; Cloudflare 24/24. FT156 first impacted-test invocation named a nonexistent file; corrected invocation and final full suite passed.

Retained P2: streaming reply replacement can cause redundant immediate process polling. No real-process integration, polling-load or browser/device focus validation. No fresh visual checks, native builds or device validation during ship. No linked issues/PRs found; none closed. Branch retained because clean is not configured.
