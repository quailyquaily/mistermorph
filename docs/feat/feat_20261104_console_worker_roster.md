---
date: 2026-11-04
title: Worker roster for subagents and coders in Console chat
status: implemented
---

# Worker roster for subagents and coders in Console chat

A chat reply whose task started subagents (`spawn`) or coders (`coder`) shows a row of
those workers below its status card. Each worker is a chip with a generated avatar, its
name and a state dot: running, done, failed or canceled. Clicking a chip opens a panel
with the worker's kind, state, process IDs and output; clicking it again closes it. The
row is not shown when a task started no workers.

## Data

The runtime keeps a `workers` list in the task's activity progress, beside `history`:

```json
{
  "id": "worker-2", "name": "Nova", "kind": "coder", "status": "running",
  "activity_id": "coder-1", "stream": "codex", "output": "…",
  "summary": "", "error": "",
  "processes": [{ "pid": 4242, "program": "codex", "activity_id": "coder-1" }]
}
```

- A worker is added when an entry that starts one appears: a `spawn` or `coder` tool call,
  or the subtask a spawn runs, carrying worker metadata (see
  `feat_20261104_console_worker_identity.md`). A spawn and its subtask share one worker.
- Tool calls a worker makes do not add workers; their process records merge into the
  worker that made them.
- After each update the roster takes each worker's latest status, output tail (the same
  6000 characters as the coder entry), summary and error. A completion without worker
  metadata is matched to its worker by the call's activity ID.
- Workers stay in the roster after their entries leave the 24-entry history. The roster
  keeps the 32 most recent workers and counts the rest in `workers_omitted`, shown as
  "N earlier".
- The list is part of the activity saved with the task result, so a finished task shows
  the same roster after a reload. Tasks saved before this change have no `workers` and
  show no roster.

## Display

- Avatars depend only on the name: a hue and a mirrored 5×5 pattern, both from a hash of
  the name. The same name looks the same in every task. Colours are mixed with the
  theme's tokens.
- A worker still marked running in a task that has ended shows the task's ending.
- Output is shown as plain text, like coder output in progress. The panel shows the
  error first, else the output, else the summary, and stays scrolled to the end while
  output arrives unless the reader scrolls up.
- Chips wrap onto more lines at phone width, and long names are truncated with an ellipsis.

## Code

- Runtime: `cmd/mistermorph/consolecmd/activity_progress.go` (`syncConsoleActivityWorkers`).
- Console: `web/console/src/core/chat-workers.js`, `web/console/src/components/ChatWorkerRoster.js`,
  rendered from `ChatHistoryItem.js`.
