# Console: worker roster for subagents and coders

## lyric · 2026-11-03 22:27

Add a place in the chat view that shows the subagents and coders working on the current task, for example a row below `.chat-status-card`. Each worker is shown as an avatar and its name (the names from the subagent names item). Clicking a worker opens its output.

### Acceptance criteria
- While a task runs, each subagent and coder it started appears with an avatar and name; finished workers stay visible with their state (running, done, failed).
- Avatars are generated per name, so a worker looks the same everywhere it appears.
- Clicking a worker shows its output (plain text, as coder output in progress) and, when it ran a process, its PID.
- The roster is hidden when a task has no subagents or coders, and works at phone width.
- It stays available for finished tasks after a reload.
