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
