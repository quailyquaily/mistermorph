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
