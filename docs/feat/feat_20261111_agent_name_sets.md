---
date: 2026-11-11
title: Choosing the name set of subagents and coders
status: implemented
---

# Choosing the name set of subagents and coders

Workers started by `spawn` and `coder` get a friendly name (see
[Worker names and process IDs](feat_20261104_console_worker_identity.md)). The name now comes
from a chosen set: **Great scientists** (the default, and the only set before), **Great
musicians** or **Great artists**. One preference, `tools.agent_name_set`, is shared by both
tools; it changes names only, never the model or how a worker behaves.

## Setting

- Config: `tools.agent_name_set: scientists | musicians | artists`. A missing, empty or unknown
  value reads as `scientists`, in the runtime and in the Console.
- Console: the **Agent name set** dropdown on the Tools page, below every tool's own settings.
  It shows a few names of the selected set in the Console's language and notes that it applies
  to new subagent and coder sessions. It joins the Tools save bar with the tool switches and is
  saved through `PUT /settings/agent` (`tools.agent_name_set`); an unknown value is rejected
  with 400. A runtime that does not report the field (older than this change) shows no control
  and is sent none.
- The key is applied with the next runtime generation, like the tool switches.

## Pools

Each set is a pool of 32 people, in English in `agent/worker_names.go` and in English, Chinese
and Japanese in `web/console-nsh/lib/core/worker-identity.js` (the same people at the same
positions; a test checks the English lists agree). The scientist pool keeps its size and order.
No name is in two pools, nor in the legacy pool of ordinary first names, so a recorded name tells
which pool it came from. Lists are append-only history: a new set is added, never an edit.

## Allocation and stability

- A task takes the set when it starts. All its workers, including nested subagents and coders,
  come from that set, in the task's random order (seed, index and avatar allocation unchanged).
- Every new worker record carries `name_set` beside `name`, `name_index` and `avatar_index`
  (events, subtask results, Console activity entries and the worker roster). An approval pause
  records `worker_name_set` in its resume state; the resumed run continues from that set even if
  the preference changed meanwhile.
- Records from before this change have no `name_set`. The runtime and the Console read them as
  before: scientists, or the legacy first names, never the set preferred now. A pause recorded
  before name sets continues with the scientists; one with no worker named yet takes the current
  preference.
- The Console shows a worker from its recorded set in the current language. A record whose set
  this Console does not know, or whose name does not match its set and index, shows the recorded
  name as it is.
