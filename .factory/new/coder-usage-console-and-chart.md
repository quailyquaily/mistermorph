# Coder usage from Console runs, and agent and coder apart in the daily chart

## factory · 2026-11-15 19:35
Recorded from the owner's request to put this in new.

Owner request:
> 1. coder usage in console also need to count. 2. usage chart need to distinguish the usage from coder and usage from agent. you may consider 2 bars per day, or other visualization if you have better ideas.

Plan: `docs/feat/feat_20261115_coder_usage_console_and_chart.md` on master (`beb05784`). Read it first; it has the sources, the counting rules, the API shape and the chart. Follows `docs/feat/feat_20261113_coder_usage_quota.md`.

Problem:
- A coder run from a Console chat on macOS or Linux runs Codex or Claude Code in a persistent terminal (`internal/coderterm`). That path reports only Claude Code's quota with an empty run, so nothing reaches `usage.db`. Runs from channels, cron jobs and heartbeats run the CLI headless and are recorded.
- `UsageStore.Daily` groups by day and model only, so the daily chart stacks coder tokens into the same segments as the agent's own calls and adds a list-price coder cost to the billed agent cost.

Requirements and acceptance criteria:

Part 1, usage of terminal runs:
- A terminal coder run records its usage in `usage.db` as a headless run does (host `codex-cli` or `claude-code`, operation and scene `coder`), and the tool result and the run's activity carry the usage line.
- Read it from the session files the terminal already follows: Claude Code's transcript and its sub-agents' files (`message.usage` once per `message.id`, per `message.model`); Codex's rollout and its sub-agents' rollouts (`token_count` lines, `last_token_usage`; model `codex`). Do not read credentials, call the CLIs' services or read their screens for this.
- Count each line once across the tasks of a session (a usage offset per file); what the CLI spent between tasks goes to the next task; a session resumed after a runtime restart starts at the file's end; a failed, cancelled or timed-out task records what was written.
- Usage and Claude Code's quota arrive in one report, so neither overwrites the other.
- Claude Code rows from a terminal run are priced from the pricing catalog, marked estimated, and repriced when the catalog changes; an unknown model and Codex rows stay without a cost. Rows that carry the CLI's own cost are left alone.

Part 2, the daily chart:
- A coder row is `operation = 'coder'`.
- `GET /stats/llm/daily` keeps every field it has and adds the agent and coder split per day and for the range (`sources`), so older Console builds and the Android app keep working.
- The chart shows agent and coder apart at 7, 30 and 90 days, on desktop and phone, without a new control. Planned form: agent above the base line, coder below it, on one scale, one column per day; same model colours on both sides; an average line and a range total per source, the coder's cost marked as list price; tooltip grouped by source; legend isolation applies to both sides.
- If `nsh/base/plot` cannot stack below the base line, use the fallback in the plan (two bars per day at 7 and 30 days, two plots sharing the day axis at 90) and record the trap in `web/console-nsh/PORTING.md`.
- A range without coder rows, and a payload without `sources` (an older agent), draw as today.

Out of scope: the summary at the top of the Usage page and the Overview page; backfilling past Console runs.

Checking:
- The tests listed in the plan's Tests section (coderterm, coder tool, llmstats, daemonruntime, Console stats).
- Look at the chart in a browser at the three ranges, desktop and phone width, with agent-only, coder-only and mixed days; record what was not checked.
- Set the plan's status to implemented and correct it where the build differs.
