---
date: 2026-03-06
title: LLM Usage Stats and Console View Plan
status: planned
---

# LLM Usage Stats and Console View Plan

## 1) Goal

- Record the token usage of every LLM request.
- Persist those usage records to a local file.
- Add a Console `Stats` view for inspecting usage from the currently selected runtime endpoint.
- Support these slices in V1:
  - total usage by API base domain
  - total usage by model
  - per-domain model breakdown

## 2) Current Facts

Verified from the current codebase on 2026-03-06:

- `llm.Result` already carries `Usage`.
- `providers/uniai` already maps upstream usage into `llm.Result.Usage`.
- `providers/uniai` also maps stream usage into `llm.StreamEvent.Usage`.
- many model calls happen outside the main agent loop:
  - agent engine
  - group trigger / addressing
  - todo semantic resolution
  - telegram init flow
  - telegram memory draft flow
- Console already reads runtime-local data through daemon HTTP routes, then proxies it through `/console/api/proxy`.

Implication:

- recording usage in `agent.Context.AddUsage(...)` is not enough
- recording stream usage would risk double-counting
- the minimum correct record point is the final `llm.Client.Chat(...)` result boundary

## 3) First-Principles Constraints

1. Record once per completed LLM request.
   Use the final `llm.Result.Usage`, not incremental stream events.

2. Record at the shared client boundary.
   Do not add ad hoc writes in each runtime, tool, or call site.

3. Persist raw request-level facts first.
   Aggregation should be derived from raw records, not treated as the source of truth.

4. Keep correlation metadata in the raw journal.
   `run_id` should be first-class. Channel-specific event ids should be optional metadata, not required fields.

5. Keep V1 dimensions small.
   Only group by:
   - API base domain
   - model

6. Do not turn this into billing infrastructure.
   V1 tracks token usage only. Pricing reconciliation is out of scope.

7. Do not rescan the whole raw journal on every stats request.
   Query paths should use a checkpointed projection and replay only the unprojected tail.

8. Keep Console stats runtime-local in V1.
   The selected endpoint in Console remains the scope boundary.

9. Re-check for overdesign after each chunk.
   If a new layer exists only to make the code look generic, remove it.

## 4) V1 Scope

- Include:
  - request-level usage persistence
  - append-only segmented usage journal
  - raw correlation metadata:
    - `run_id`
    - optional `origin_event_id`
  - daemon read API for usage summary
  - checkpointed projection file
  - Console `Stats` view
  - aggregation by API domain
  - aggregation by model
  - nested per-domain model breakdown

- Exclude:
  - charts
  - cross-endpoint aggregation inside Console
  - time-range filtering
  - pricing tables
  - request replay or raw prompt inspection from the stats page
  - external database / OLAP / background projection worker
  - grouping by `run_id` or `origin_event_id`

## 5) Data Recording Design

### Record point

Add a small `llm.Client` decorator that wraps `Chat(...)`:

- call the underlying client
- on successful return, write one usage record
- use final `llm.Result.Usage`
- do not write per-stream delta usage

This wrapper should be applied wherever the app constructs shared LLM clients:

- `runcmd`
- `daemoncmd`
- channel runtimes created through `llmRuntimeResolver`

This keeps the instrumentation centralized without modifying every caller.

### File format

Use an append-only JSONL journal with memory-style segmented rotation.

Proposed layout:

```text
<file_state_dir>/stats/llm_usage/
  since-2026-03-07-0001.jsonl
  since-2026-03-07-0002.jsonl
<file_state_dir>/stats/llm_usage_projection.json
```

Why this is the right journal shape:

- append-only writes are simple and safe
- easy to inspect manually
- it matches the existing memory journal mechanism
- it preserves replayable `file + line` checkpoints across rotation
- avoids inventing a new storage engine

Important clarification:

- usage stats should follow the `memory` journal pattern
- usage stats should not use the simpler `guard` audit rotate style
- the reason is that usage stats need projection replay correctness after rotation

### One record per request

Proposed V1 record shape:

```json
{
  "ts": "2026-03-06T15:04:05Z",
  "run_id": "run_01JNK8K8P8H5A7M9X3B3Q4M6QW",
  "origin_event_id": "evt_1234567890",
  "provider": "openai",
  "api_base": "https://api.openai.com/v1",
  "api_host": "api.openai.com",
  "model": "gpt-5.2",
  "scene": "telegram.init_questions",
  "input_tokens": 123,
  "output_tokens": 45,
  "total_tokens": 168,
  "duration_ms": 1840
}
```

Field notes:

- `ts`
  - write time in UTC
- `run_id`
  - primary correlation key across one logical run
  - should be present whenever the request happens inside an agent/task run
- `origin_event_id`
  - optional upstream event id for channel-driven requests
  - examples:
    - Telegram update id equivalent if available later
    - Slack event id
    - Lark event id
  - CLI and some internal helper calls may legitimately leave this empty
- `provider`
  - resolved provider name used for this client
- `api_base`
  - normalized base URL string when available
- `api_host`
  - parsed host from `api_base`
  - if parsing fails or the base is empty, use a small sentinel such as `provider:<provider>`
- `model`
  - resolved request model
- `scene`
  - use existing `llminspect.ModelSceneFromContext(ctx)` when available
  - fallback to `unknown`
- `input_tokens`, `output_tokens`, `total_tokens`
  - copied from `llm.Result.Usage`
- `duration_ms`
  - request wall-clock duration

### Normalization rules

- trim whitespace on `run_id` and `origin_event_id`
- trim whitespace on provider, model, and base URL
- normalize API base before extracting host
- store `api_host` in lowercase
- keep the raw normalized `api_base` string for debugging, but aggregate by `api_host`
- keep `run_id` and `origin_event_id` only in the raw journal
- do not aggregate by `run_id` or `origin_event_id` in V1

## 6) Aggregation Design

V1 should use:

- raw journal as source of truth
- one projection file with embedded checkpoint metadata for query speed

Proposed files:

```text
<file_state_dir>/stats/llm_usage/
  since-YYYY-MM-DD-NNNN.jsonl
<file_state_dir>/stats/llm_usage_projection.json
```

Why this is the right minimum:

- raw segmented journal preserves auditability and future joinability
- projection avoids full rescans as the raw file grows
- projection remains derived state, so rebuild is always possible
- the projection already stores `projected_offset`, so a second checkpoint file is unnecessary in V1

### Projection model

Projection should include:

- `updated_at`
- `projected_offset`
  - `file`
  - `line`
- `projected_records`
- `summary`
- `api_hosts`
- `models`
- `api_hosts[].models`

The important checkpoint is `projected_offset`:

- it points to the journal segment file and line already folded into the projection
- stats reads only need to replay the tail after that checkpoint

### Rotation model

Rotation should follow the existing memory journal behavior:

- segmented files
- rotate by size
- each append returns a logical offset of `file + line`
- replay starts from a logical checkpoint of `file + line`

V1 decisions:

- rotate by size, not by time policy
- default segment naming follows memory journal conventions
- closed segments may optionally be compressed later, but compression is not required for the first implementation
- no retention deletion in V1

Why no retention deletion in V1:

- the raw journal remains the source of truth
- deleting historical segments would make projection the only truth, which weakens rebuild and audit guarantees

### Projection update flow

The intended flow is:

1. writers append raw usage records to the current usage journal segment
2. the append path receives a logical offset: `file + line`
3. stats reads load `llm_usage_projection.json`
4. before returning stats, the runtime replays only the journal tail after `projected_offset`
5. it writes the updated projection atomically, including the refreshed `projected_offset`
6. the response is served from that refreshed projection

This means:

- writers stay simple
- reads stay fast after the initial build
- projection update logic is centralized
- rotation does not break replay correctness

### Rebuild rules

Do a full rebuild only when needed:

- projection file missing
- projection decode fails
- embedded projection checkpoint is invalid
- required segment file is missing
- segment ordering is invalid
- `projected_offset` is invalid for the current journal state

Normal steady-state reads should not do a full scan.

### Summary payload

Proposed runtime API:

```text
GET /stats/llm/usage
```

Proposed response shape:

```json
{
  "generated_at": "2026-03-06T15:10:00Z",
  "summary": {
    "requests": 120,
    "input_tokens": 120000,
    "output_tokens": 34000,
    "total_tokens": 154000
  },
  "api_hosts": [
    {
      "api_host": "api.openai.com",
      "requests": 80,
      "input_tokens": 80000,
      "output_tokens": 22000,
      "total_tokens": 102000,
      "models": [
        {
          "model": "gpt-5.2",
          "requests": 50,
          "input_tokens": 54000,
          "output_tokens": 15000,
          "total_tokens": 69000
        },
        {
          "model": "gpt-4.1",
          "requests": 30,
          "input_tokens": 26000,
          "output_tokens": 7000,
          "total_tokens": 33000
        }
      ]
    }
  ],
  "models": [
    {
      "model": "gpt-5.2",
      "requests": 70,
      "input_tokens": 70000,
      "output_tokens": 19000,
      "total_tokens": 89000
    }
  ]
}
```

Why this shape:

- top-level summary handles the "total" case
- `api_hosts[]` handles the domain angle
- `models[]` handles the global model angle
- nested `api_hosts[].models[]` handles the combined domain + model angle

No separate cross-product table is required in V1.

## 7) Console View Design

Add a new Console view:

- route: `/stats`
- nav label: `Stats`

The view remains endpoint-scoped, like `Dashboard`, `Tasks`, `Audit`, and `Files`.

### V1 layout

1. Summary cards
   - total requests
   - input tokens
   - output tokens
   - total tokens

2. By API domain table
   - one row per `api_host`
   - sortable by total tokens

3. By model table
   - one row per model
   - sortable by total tokens

4. Domain detail section
   - selectable domain
   - shows model rows under that selected domain

This covers all user goals without adding charts or multiple screens.

### Interaction model

- load from runtime API through existing Console proxy
- refresh on:
  - initial page load
  - selected endpoint change
  - optional periodic refresh, same 60s rhythm as Dashboard

No write actions are needed.

## 8) Storage and Path Helpers

Proposed additions:

- `internal/statepaths`
  - helper for the usage journal dir
  - helper for the usage projection path
- `internal/llmstats`
  - request record type
  - usage journal wrapper
  - `llm.Client` wrapper
  - projection types
  - projection updater / tail replay logic

This package split is still minimal:

- `statepaths` owns the path
- `llmstats` owns request-level stats logic

Do not spread usage file logic into:

- `agent`
- `providers/uniai`
- `web/console`
- each channel runtime

## 9) Task Breakdown

### 0. Docs and scope freeze

- [x] write this feature doc
- [x] freeze V1 dimensions:
  - [x] API domain
  - [x] model
  - [x] domain -> models nested breakdown
- [x] freeze V1 storage:
  - [x] memory-style segmented usage journal
  - [x] projection JSON with embedded `projected_offset`
- [x] freeze V1 correlation metadata:
  - [x] `run_id`
  - [x] optional `origin_event_id`
- [x] freeze anti-overdesign rules

Acceptance criteria:

- [x] no doc or implementation introduces charts, DBs, or cross-endpoint aggregation in V1

### 1. Shared stats package

- [x] add `internal/llmstats`
- [x] define request record type
- [x] define summary types
- [x] implement host normalization helper
- [x] implement usage journal append
- [x] implement `llm.Client` decorator
- [x] implement projection types
- [x] implement tail-replay projection updater

Acceptance criteria:

- [x] one successful `Chat(...)` call appends exactly one journal record
- [x] stream callbacks do not create extra records
- [x] raw records carry `run_id` when a run context exists
- [x] channel-driven records may carry optional `origin_event_id`
- [x] journal rotation does not break checkpoint replay

### 2. Wiring at client creation edges

- [x] wrap clients in `runcmd`
- [x] wrap clients in `daemoncmd`
- [x] wrap clients returned by `llmRuntimeResolver.CreateClient(...)`

Acceptance criteria:

- [x] agent loop calls are recorded
- [x] non-agent helper calls are also recorded
- [x] no runtime-specific code writes usage records directly

### 3. Runtime read API

- [x] add daemon route:
  - [x] `GET /stats/llm/usage`
- [x] read and refresh projection
- [x] aggregate totals by projection:
  - [x] summary
  - [x] model
  - [x] API domain
  - [x] API domain -> models
- [x] return stable JSON payload
- [x] add daily route (2026-09-25):
  - [x] `GET /stats/llm/daily?days=30&tz=Asia/Shanghai`
  - [x] `days` defaults to 30 and is capped at 366; a non-positive or non-numeric value is a 400
  - [x] `tz` is an IANA zone name (UTC when absent, 400 when unknown); days split at midnight in that zone
  - [x] response: `time_zone`, `from`, `to`, `summary` (range totals) and `days` (one entry per calendar day, oldest first, zero totals for idle days), each with the same fields as `summary`
  - [x] reads the journal directly instead of the projection, so any zone can be served without storing per-zone buckets; segments that end before the range are skipped, and costs are backfilled from pricing the same way as the projection
  - [x] the console Stats page draws it as the Daily chart

Acceptance criteria:

- [x] empty file returns zeroed summary, not an error
- [x] malformed line handling is explicit and does not crash the route
- [x] steady-state reads replay only the unprojected tail
- [x] invalid projection offset triggers rebuild

### 4. Console stats view

- [x] add router entry `/stats`
- [x] add nav item
- [x] add `StatsView`
- [x] render summary cards
- [x] render by-domain table
- [x] render by-model table
- [x] render selected-domain model breakdown

Acceptance criteria:

- [ ] switching runtime endpoint refreshes stats correctly
- [ ] the view is readable on desktop and mobile

### 5. Tests

- [x] recorder tests
- [x] projection tests
- [x] daemon route tests
- [ ] Console smoke-level view test or manual verification notes

Acceptance criteria:

- [ ] no double-counting from stream usage
- [x] projection totals match fixture input
- [ ] tail replay matches full rebuild output

Current remaining validation work:

- manual Console smoke verification
- explicit stream no-double-counting test
- explicit tail-replay vs full-rebuild equivalence test

## 10) Risks and Decisions

### Risk: double counting stream usage

Decision:

- ignore stream usage for persistence
- record only final `llm.Result.Usage`

### Risk: missing or unparsable API base

Decision:

- keep `api_base` as normalized string when available
- aggregate by `api_host`
- use `provider:<provider>` as fallback host bucket when host extraction is impossible

### Risk: JSONL file growth

Decision:

- keep raw segmented journal as source of truth
- add a checkpointed projection now
- replay only the unprojected tail during stats reads

### Risk: using the wrong existing rotation pattern

Decision:

- reuse the `memory` journal pattern conceptually
- do not use the `guard` single-path rename rotate pattern for usage stats
- the deciding factor is replayable checkpoint correctness after rotation

### Risk: high-cardinality metadata explodes the UI

Decision:

- keep `run_id` and optional `origin_event_id` in the raw journal only
- do not expose them as first-class aggregation dimensions in V1

### Risk: adding too many dimensions too early

Decision:

- V1 only supports:
  - summary
  - by API domain
  - by model
  - per-domain model breakdown

## 11) Compression Review

Current minimum model still holds:

- one append-only segmented raw journal
- one projection file that also carries `projected_offset`
- one shared client wrapper
- one runtime summary route
- one Console stats page

Anything more than that is not justified yet.
