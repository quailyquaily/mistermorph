---
date: 2026-11-04
title: Worker names and process IDs in Console progress
status: implemented
---

# Worker names and process IDs in Console progress

Each `spawn` and `coder` call gets a task-local worker ID and a friendly name before
its first progress event. The tool call and its subtask share that identity. Nested
workers share the task's allocator. Names come from a pool of 32 famous scientists
(Einstein, Curie, Noether, ...); later rounds add numeric suffixes, such as `Curie-2`,
so names stay distinct when the pool is exhausted. The display name is not used as an
identifier.

The Console shows each scientist in the form conventional in its language (`Curie`,
`居里`, `キュリー`), with English for languages without a pool. The pool position is
part of the recorded `name_index`, so the pool keeps its size and order. Workers named
before the scientist pool carry ordinary first names (`Milo`, `Luna-2`, ...); a
record whose name is the old name at its index, or an old name without an index, keeps
showing that name in each language rather than the scientist now at that position. A
name matching neither pool is shown as recorded.

Events, subtask results, and Console activity entries carry optional `worker`
metadata with `id`, `name`, and `processes`. Each process record has an OS `pid`, a
`program` basename, and the originating `activity_id` when available. Multiple
processes remain separate records. Updates merge records by these three fields so
an older snapshot cannot erase a process already reported.

CLI and shell runners report a PID only after the OS starts the process. Persistent
coder terminals report their actual PID for each task, including session reuse.
In-process subtasks and failed process starts do not invent a PID. Shell start
callbacks used for elevation continue to run. PID collection does not parse logs.
Only directly managed processes are reported; descendants started inside a coding
CLI are not enumerated.

Console shows the worker name and program-labelled PIDs on the worker's tool and
subtask entries, including calls nested under codemode. Other tool entries show only
PIDs originating from that call. These are historical process records, not process
liveness indicators. Completion does not clear them, even when the parent task
fails or is canceled. The existing activity history limits still apply.

Finished task results retain this metadata through the existing activity persistence
path. Reloading uses the saved names and PIDs, without allocating new names or probing
old PIDs. Older saved tasks without worker metadata remain readable and display as
before. No configuration keys or settings are added.

Since 2026-11-11 the pool is a chosen name set (scientists by default, or musicians or
artists); see [Choosing the name set](feat_20261111_agent_name_sets.md).
