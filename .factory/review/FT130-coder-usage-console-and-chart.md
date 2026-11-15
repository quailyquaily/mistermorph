---
branch: factory/FT130-coder-usage-console-and-chart
round: 1
---
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

## factory · plan · 2026-11-15 20:07

Behaviour
- Track terminal-session transcript usage per file separately from turn reading: new files start at zero, resumed known files at EOF; retain partial lines and per-message deduplication, collect child session usage, and report once on all completion paths including cancellation/error. Between-task writes belong to the next task.
- Convert Claude and Codex tokens per the feature document, and combine usage with Claude quota in a single terminal report. Persist coder rows and show usage in results/activity.
- Price missing-cost known Claude coder models from the catalog and reprice catalog-derived rows without replacing CLI-provided costs; keep unknown/Codex unpriced.
- Daily API retains combined values and adds agent/coder sources, including zero sources and cache details. Chart splits sources at 7/30/90 days with shared model colours, independent totals/averages, grouped tooltip and isolation. Agent-only and legacy payloads retain existing presentation.
Scope
- internal/coderterm, coder runtime integration, coderusage, llmstats daily and catalog pricing, daemon API, Console daily chart and regression tests; update feature document status and implementation differences.
- No historical backfill, overview/usage-summary redesign, credential/service/screen reads, or unrelated refactors.
Decisions
- Follow docs/feat/feat_20261115_coder_usage_console_and_chart.md and existing coder quota design. Use coderterm-owned usage types to avoid package coupling. operation=coder is the source discriminator.
- First try signed stacking on nsh/base/plot; use the documented fallback if unsupported and describe the limitation in PORTING.md. Preserve a single model legend and legacy API compatibility.
- Usage readers must handle truncated/appended files, duplicate message IDs, incomplete final records and child lineage without accidentally collecting another session's data.
Checking
- Add deterministic transcript/rollout fixtures covering multiple models/blocks/tasks, children, restart offsets and failure; terminal usage+quota/result persistence tests; pricing/repricing and source aggregation/cache consistency; route compatibility; Console chart source/legacy/isolation tests.
- Run configured gofmt check, go vet ./..., go test ./...; run nsh check and scripts/test.sh for Console changes, with scripted tests using an absolute throwaway HOME.
- Try browser inspection for 7/30/90 days at desktop/mobile widths with agent-only/coder-only/mixed data; explicitly record anything that cannot be checked.

## factory · 2026-11-15 20:07

Implemented in fa542745 and 92edfa11; branch head 92edfa11. Terminal transcript/rollout usage now records per task including child files and error/cancel paths, with usage and quota in one report. Catalog pricing/repricing handles missing-cost coder rows. Daily API preserves combined fields and adds sources; Console renders agent above and coder below one shared baseline with separate totals/averages, tooltip source groups and shared model isolation. Legacy/agent-only payloads retain existing rendering. Feature document marked implemented.

Decisions: Codex repeated running totals are deduplicated; Claude synthetic messages ignored and IDs deduplicated across files. Resumed readers in the same runtime retain their offsets; restart resumes at EOF. Truncated files resume from their new end. Signed stacking uses an unpainted spacer; plot traps documented in PORTING.md. Split figures replace Peak/Today with source totals/averages; coder costs labelled list price. No installs, manifest/lock changes, or config keys.

Manager verification: gofmt check, go vet ./..., go test ./... PASS with throwaway HOME; nsh check PASS; Console scripts/test.sh: 125 files, 0 failed; daily-usage Node tests: 11 pass. Clean worktree, only item commits, no forbidden paths changed.

Coder browser inspection: 7/30/90 days at desktop 1280 and phone 390 widths; mixed, agent-only, coder-only and legacy data, desktop tooltip, legend isolation and Tokens/Cache views. Bar ordering and phone figures overflow found and fixed.

Not checked: live Codex/Claude terminal end-to-end; phone tooltip (probe did not open it); GPUI desktop, Android device and zh/ja UI. Fixtures cover readers and runtime reporting. No linked GitHub issue/PR. Moved new/ to review/, round 1.
