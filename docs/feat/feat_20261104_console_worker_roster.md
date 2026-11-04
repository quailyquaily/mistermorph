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
  "activity_id": "coder-1", "stream": "codex", "output": "…", "result": "…",
  "summary": "", "error": "",
  "processes": [{ "pid": 4242, "program": "codex", "activity_id": "coder-1" }]
}
```

- A worker is added when an entry that starts one appears: a `spawn` or `coder` tool call,
  or the subtask a spawn runs, carrying worker metadata (see
  `feat_20261104_console_worker_identity.md`). A spawn and its subtask share one worker.
- Tool calls a worker makes do not add workers; their process records merge into the
  worker that made them.
- `output` is the tail of what a coder printed (6000 characters, as in the coder entry). It
  is appended straight from each output event, matched by worker ID or activity ID, so it
  does not depend on the coder's entry still being in the history.
- `result` is the worker's final answer, read from the result envelope its `spawn` or
  `coder` call returns: text as it is, structured output as indented JSON, kept to the
  first 6000 characters.
- Status comes from three sources, and a less trusted one never overrides a more trusted
  one: the call entry, then the subtask entry, then the returned result's own status. A
  spawn call reports done once it has handed back its subagent's result, even a failed one,
  so a failed subagent stays failed. A completion without worker metadata is matched to
  its worker by the call's activity ID.
- With Guard on, the Console keeps only the status of a returned result; its output,
  summary and error are dropped, as for other tool results.
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
- The panel shows the error, the final result and the output, each as plain text like
  coder output in progress, labelled when there is more than one. The summary stands in
  when there is neither result nor output. It stays scrolled to the end while output
  arrives unless the reader scrolls up.
- Chips wrap onto more lines at phone width, and long names are truncated with an ellipsis.

## Code

- Runtime: `cmd/mistermorph/consolecmd/activity_progress.go` (`syncConsoleActivityWorkers`).
- Console: `web/console/src/core/chat-workers.js`, `web/console/src/components/ChatWorkerRoster.js`,
  rendered from `ChatHistoryItem.js`.
