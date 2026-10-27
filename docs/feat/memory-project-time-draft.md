# Memory Project-Time Draft

> Superseded. This describes the projector design removed in `804e2a20`
> (`feat_20260819_remove_memory.md`). The current design is `feat_20261027_memories.md`.

## Goal

Move memory drafting from channel task execution into the memory projection stage.

The intended pipeline is:

1. `channel runtime` writes a raw memory event into the journal/log.
2. `memory projector` reads raw events and resolves a draft.
3. `memory projector` writes projected short-term and long-term memory artifacts.

This replaces the old shape:

1. `channel runtime` called LLM to build `SessionDraft`
2. `channel runtime` wrote drafted event into the journal
3. `projector` only merged precomputed draft

## Why

- The memory journal should be a project-level raw source of truth, not a place that already contains channel-local interpretation.
- LLM draft generation is part of projection, not ingestion.
- Channel runtimes should only normalize source data and append raw events.
- Projection can now use current projected state (`existing short-term content`) when resolving new drafts.

## Event Shape

New events are written with raw fields:

- `task_text`
- `final_output`
- `source_history`
- `session_context`

Projector behavior:

- projector asks its `DraftResolver` to derive a draft from raw event data
- old journal compatibility is intentionally dropped; replay expects the raw event shape

## Draft Resolver

`memoryruntime.NewDraftResolver(...)` owns the project-time draft strategy.

- If an LLM client is configured and the event has enough source history, it calls `memory.draft`.
- Otherwise it falls back to a simple deterministic summary derived from `final_output`.

This keeps the draft decision inside memory/projection, not inside channel task execution.

## Channel Responsibilities

Channels now only append raw events:

- Telegram: appends source history plus session context.
- Slack: appends source history plus session context.
- Heartbeat: appends raw summary output and minimal session context.

No channel task path should call `BuildLLMDraft` directly anymore.
