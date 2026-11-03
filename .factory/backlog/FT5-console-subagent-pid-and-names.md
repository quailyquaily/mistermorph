# Console: show subagent and coder names and process IDs in progress

## lyric · 2026-11-03 22:27

In the chat progress panel, subagent entries (`spawn`) and coder entries should say which worker they are and which process they run.

- Give each subagent and each coder a made-up name, for example a short friendly name, and show it on its progress entries. A name stays the same for that worker for the whole task, and different workers in one task get different names.
- When a subagent or coder runs a process (the Codex or Claude Code CLI, a terminal session, or a command), show its PID.

### Acceptance criteria
- Every subagent and coder entry in progress shows its name; the same worker keeps its name across updates and after the page reloads.
- Entries that started a process show its PID; entries without a process show none.
- Names and PIDs are kept in the task result, so finished tasks show them too.
- Regression tests cover name assignment (stable, distinct within a task) and PID reporting.
