---
date: 2026-11-15
title: "Coder usage from Console runs, and agent and coder apart in the daily chart"
status: implemented
---

# Coder usage from Console runs, and agent and coder apart in the daily chart

Follows `feat_20261113_coder_usage_quota.md`.

## Problem

1. **Console coder runs record no usage.** A coder run from a Console chat on macOS or Linux runs Codex or Claude Code in a persistent terminal (`internal/coderterm`). That path has no JSON stream, so it reports only Claude Code's quota and an empty run (`internal/channelruntime/taskruntime/runtime.go`, the `WithCoderTerminal` callback), and nothing reaches `usage.db`. Runs from the channels, cron jobs and heartbeats run the CLI headless and are recorded. The Usage page therefore misses the coder runs of the place the coder is used most.
2. **The daily chart mixes agent and coder usage.** `UsageStore.Daily` groups by day and model only. Claude Code's tokens for a model are stacked into the same segment as the agent's own calls to that model, and the two costs are added although they are different kinds of money: the agent's is what the provider bills, the coder's is a list price on a subscription.

## Goals

- Every coder run writes its usage to `usage.db`, whichever way the CLI was run.
- The daily chart shows agent usage and coder usage apart, at every range and width, without a new control.

Not in this change: the summary at the top of the Usage page and the Overview page keep their combined totals; the API host blocks already show the coders apart (`codex-cli`, `claude-code`). Console runs made before this change are not backfilled.

## Part 1: usage of terminal runs

### Source

The terminal session already follows each CLI's own session file to know when a task is done (`claude_transcript.go`, `codex.go`). The same files carry the usage. Checked against Claude Code 2.1.325 and the Codex CLI's rollouts of 2026-11-14.

| | Where | What |
|---|---|---|
| Claude Code | The session's transcript, and each sub-agent's `<session id>/subagents/agent-*.jsonl` | Every `assistant` line has `message.id`, `message.model` and `message.usage` (`input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`). One response is written as several lines (one per content block) with the same `message.id` and the same usage. |
| Codex | The session's rollout, and each sub-agent's rollout under the same `sessions` folder | `event_msg` lines with `payload.type` `token_count`: `info.total_token_usage` (running total of the thread) and `info.last_token_usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`). |

As before, nothing reads the CLIs' credentials, calls their services or reads their screens for this.

### Counting

- **Claude Code:** sum `message.usage` once per `message.id` (the last line of an id wins), per `message.model`. `InputTokens` is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, as `ClaudeResultUsage` counts a stream run.
- **Codex:** sum `last_token_usage` over the `token_count` lines. The model is `codex`, as a headless run's is, so both ways of running Codex land in one model row.
- **Turns:** the number of turns the reader saw end in the task.
- **What a task counts:** each session keeps a usage offset per file, apart from the turn reader's offset. A task's usage is everything written between that offset and the task's end, in the session's file and its sub-agents' files. So what the CLI spent between tasks (a compaction, a background agent's late report) is counted with the next task, and nothing is counted twice. A new session starts at 0; a session resumed after the runtime restarted starts at the file's size at that moment.
- **A task that fails, is cancelled or times out** records what was written until then.

### Reporting

- The turn readers accumulate the usage; `coderterm.Request` gets a `Usage` callback beside `Status`, called once when the task ends with the usage per model and the turn count. `coderterm` keeps its own small type for this and does not import `coderusage`.
- The runtime's `WithCoderTerminal` callback turns it into a `coderusage.Run` and makes one `request.Report(run, quota)` with the quota the status line gave (today's `Status` callback reports the quota with an empty run; the two become one report so neither overwrites the other).
- From there nothing changes: `coderTool.reportUsage` records the run (`host` `codex-cli` or `claude-code`, `operation` and `scene` `coder`), reads Codex's quota, and writes the usage line into the tool result and the run's activity.

### Cost

The transcript has no cost. Claude Code rows from a terminal run are priced from the pricing catalog (`uniai.DefaultPricingCatalog`, as chat rows without a cost are), marked estimated, with `cost_source` `catalog`: the same list price the CLI reports for a headless run, and split into input, cached, cache write and output cost, which the CLI's figure is not. For this:

- `UsageStore.Append` prices a `coder` row that has a model and no cost, as it prices a `chat` row; the reprice pass after a catalog change includes those rows.
- A model the catalog does not know stays without a cost. Codex rows (`codex`) stay without a cost, as today.

Rejected: the status line's `cost.total_cost_usd`. It is a running total of the session with no split per model, and a task's cost would be a difference between two reads of a file written at Claude Code's own pace.

## Part 2: agent and coder in the daily chart

### What a coder row is

`operation = 'coder'`. The constant moves to `llmstats` (`OperationCoder`), which `coderusage` already imports; `coderusage.OperationCoder` goes.

### API

`GET /stats/llm/daily` keeps every field it has (combined totals, for older Console builds and the Android app) and adds the split:

```json
{
  "summary": { "...": "combined, as today" },
  "models": [],
  "sources": {
    "agent": { "summary": {}, "models": [] },
    "coder": { "summary": {}, "models": [] }
  },
  "days": [
    {
      "date": "2026-11-15",
      "...": "combined, as today",
      "models": [],
      "sources": {
        "agent": { "totals": {}, "models": [] },
        "coder": { "totals": {}, "models": [] }
      }
    }
  ]
}
```

`UsageStore.Daily` groups by `days.i, (r.operation = 'coder'), r.model` (and the cache details query likewise), fills the two sources, and adds them up for the combined fields. A source without rows is present with zero totals.

### Chart

**Agent above the base line, coder below it, on one scale.** One column per day, as now.

```
  agent  ▲      █
         │  █   █       █
         │  █   █   █   █
  ───────┼──█───█───█───█───  0
         │  █       █   █
  coder  ▼  █           █
            █
           11  12  13  14
```

- Each half is the stack it is today: model segments (cost, tokens) or cache parts (cache), same colours. Model colours are assigned over both sources together, so a model is one colour on both sides; today's column is hatched on both sides.
- The value axis reads the same above and below (no minus signs), with a small `Agent` label at its top end and `Coder` at its bottom end. Both halves share the scale, so a day's coder use can be compared with its agent use by eye.
- A dashed average line per half, each the average of its own source.
- The readout above the plot shows two totals for the range, Agent and Coder, in place of the one; the coder's cost is marked as list price. The hover tooltip has a group per source, each with its subtotal and model rows.
- The legend stays one row of models. Pressing an entry isolates that model on both sides.
- A range without coder rows draws as today: no lower half, no labels, one total.

Why not two bars per day: at 90 days two bars per day are 180 bars, under 4 px each in the desktop plot and less on a phone, and the eye has to pair them. One column per day stays readable at every range. Why not an Agent / Coder / All switch: it hides the comparison, which is the point, and adds a control.

`nsh/base/plot` has no stack that goes both ways, but one stack can be made to: the agent's bars, an unpainted bar of minus their sum that takes the stack back to the base, then the coder's bars with negative values, on a scale from `-max` to `max`. So the planned form was built and the fallback (two bars per day at 7 and 30 days, two plots at 90) was not needed. The trap is in `web/console-nsh/PORTING.md`.

`lib/core/daily-usage.js` (`summarizeDailyUsage`) builds both halves from `sources`; a payload without `sources` (an older agent) is drawn as the single stack of today.

## Tests

- `internal/coderterm`: usage from captured Claude Code transcripts (several lines per `message.id`, two models, a sub-agent file) and Codex rollouts (`token_count` lines, a sub-agent rollout); two tasks in one session count each line once; a resumed session starts at the file's end; a failed task reports what was written.
- `agent/coder_usage_test.go`: a terminal run's usage and quota arrive in one report, the rows in `usage.db`, and the usage line in the result.
- `internal/llmstats`: a `coder` row with a known model is priced from the catalog and repriced when the catalog changes; one with an unknown model or with the CLI's own cost is left alone. `Daily` with agent and coder rows of the same model on the same day: both sources, the combined fields their sum, a day with only one source.
- `internal/daemonruntime`: `/stats/llm/daily` carries `sources` and the old fields.
- `web/console-nsh/tests/stats.test.tsx`: both halves, the two totals and averages, the tooltip groups, isolating a model, a payload without coder rows, a payload without `sources`.

## As built

The plan above was built as written, with these differences and details:

- **Where the readers live.** `internal/coderterm/usage.go` has a usage reader per CLI (`claudeUsage`, `codexUsage`), apart from the turn readers, with its own offset per file. A session reads it once when a task ends, after the CLI was stopped if the task failed, so a failed task's last lines are counted. `coderterm.Request.Usage` is not called when the files record nothing.
- **A session reopened in the same runtime** (after a failed task, or when the CLI exited between tasks) keeps its reader, so it counts on from where it was. Only a reopened session without one starts at the files' end; the runtime keeps no resume points over a restart today, so that path is covered by tests alone.
- **Claude Code.** A response is counted by its last line: when a later line of the same `message.id` carries other numbers, the difference is added. The IDs are kept for the session over all its files, so a response repeated in a sub-agent's file is counted once. Messages of the model `<synthetic>` (Claude Code's own notices) are skipped. Sub-agents' files are every `agent-*.jsonl` under `<session id>/subagents/`, sub-folders included. Turns are the main transcript's responses that ended a turn.
- **Codex.** A `token_count` line whose `total_token_usage` equals the one before it in that file is not counted: Codex writes the line again when only its rate limits changed. Lines without `info` are skipped. Sub-agents are found from the `sub_agent_activity` lines of the session's rollout and of the sub-agents' own; a rollout that is not written yet is looked for again at the next task. Turns are the session's own `task_complete` lines.
- **A file that got shorter** (cut or replaced) is not counted again; reading goes on from its new end. A line that does not parse is skipped. Reading usage never fails a task.
- **One report.** `taskruntime.coderTerminalReport` gathers the usage and the status line's quota and makes the one `request.Report`; it also gives the run its duration.
- **The usage line of a terminal run has no cost**: the cost is worked out when the rows are written, not by the CLI. The rows in `usage.db` have it.
- **Cost.** `llmstats.catalogPriced` names the operations priced from the catalog (`chat`, `coder`). A coder row priced from it is always marked estimated.
- **API.** A source's `models` is an empty list, not absent, when it has no rows.
- **Chart, when the two are drawn apart:**
  - The plot is taller (260 pt, 210 pt on phones; 184 and 150 otherwise), so each half keeps about the room the single stack had.
  - The figures under the plot are Agent total, Coder total (with `list price` beside a cost), Agent avg / day, Coder avg / day, Active days and Cache rate. Peak and Today are not shown there; today's two values are in the readout. On phones the agent's figures are one row and the coder's the next.
  - The readout of the focused day shows the day's Agent and Coder cost in place of the one Cost.
  - The tooltip has no overall total: the two subtotals are different kinds of money.
  - The cache view draws each half's cache split, and keeps its own figures (combined).
  - The split is drawn when the range has coder rows (`sources.coder.summary.requests > 0`), also when the agent has none.

Not checked: a live Codex or Claude Code terminal run end to end (the readers are tested against lines in the shape the CLIs write), the GPUI desktop app and an Android device. The chart was looked at in Chrome (the built web Console with stubbed APIs) at 7, 30 and 90 days, 1280 pt and 390 pt wide, with mixed, agent-only, coder-only and no-`sources` data.
