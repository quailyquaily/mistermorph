---
date: 2026-11-13
title: "Coder usage and subscription quotas"
status: implemented
---

# Coder usage and subscription quotas

## Goal

The `coder` tool runs the local Codex and Claude Code CLIs, which bill against the user's own subscription. Show what each run used and how much of each subscription's quota is left, in the Console and to the agent, so a run is not started into a limit that stops it halfway.

## Sources

Only what the CLIs themselves report. MisterMorph never reads their credentials, calls their services, or scrapes their interactive screens. Checked against Codex CLI 0.169.0 and Claude Code 2.1.323 (2026-11-13).

| | Run usage | Quota |
|---|---|---|
| Codex (`codex exec --json`) | `turn.completed.usage`: input, cached input, cache write, output and reasoning tokens. No model name. | Not in the exec stream. Read from `codex app-server` (JSON-RPC over stdio): `initialize`, `initialized`, then `account/rateLimits/read`. Its `rateLimits` has `planType`, `primary`/`secondary` windows (`usedPercent`, `windowDurationMins`, `resetsAt`) and `rateLimitReachedType`. The read uses no quota. |
| Claude Code (`claude -p --output-format stream-json`) | `result`: `modelUsage` per model (tokens, cache reads and writes, `costUSD`), `num_turns`; else `usage` and `total_cost_usd`. | `rate_limit_event` during the run: `rate_limit_info.status` and `unifiedWindows` (`five_hour`, `seven_day`, …, each `utilization` 0–1, `resetsAt`, `status`). |

Claude Code's cost is its list price (`costBasis: list`); on a subscription it is not what is billed, so the rows mark it estimated.

## Behaviour

- `internal/coderusage` parses both CLIs' events into a `Run` (usage per model) and a `Quota` (plan, status, windows), reads Codex's quota (`ReadCodexQuota`), and records them.
- The coder tool's stream collector keeps the run's usage and Claude Code's quota; when the CLI ends, the tool records the run in `usage.db` (one row per model, host `codex-cli` or `claude-code`, operation `coder`, cost only from the CLI), reads Codex's quota after a Codex run, and saves the coder's last quota in `usage.db` (`coder_quota`, one row per coder; an older report never replaces a newer one).
- The tool result has a `usage` field: the run's usage and the quota in a line. The tool description tells the agent to tell the user, rather than retry, when a limit is reached or nearly used up. The run's activity ends with the same line.
- Runs in Console terminal sessions have no JSON stream and record no usage; Codex's quota is still read after them.
- `GET /stats/coder/quota` returns the saved quotas and which CLIs the runtime finds (`PATH` plus `tools.coder.path_extra`); `POST /stats/coder/quota/refresh` reads Codex's quota first and reports a failure per coder in `errors`.
- The Console's Usage page shows a Coding agents block: per coder its plan, a near-limit or limit-reached badge, when it reported, and a bar per window with the share used and when it resets (amber from 70% or when the CLI warns, red from 90% or at the limit). A window whose reset time has passed says so instead of its stale share. Refresh reads Codex's quota. The block is hidden when neither CLI is installed and no quota was saved, and for agents built before the routes (404).

## Tests

- `internal/coderusage/coderusage_test.go`: the captured events of both CLIs, statuses, notes, rows and quotas in `usage.db`, the app-server read against a stand-in server, command lookup.
- `agent/coder_usage_test.go`: the coder tool with fake CLIs: Claude Code's usage, quota and rows; Codex's two turns and the quota read after the run.
- `internal/daemonruntime/server_coder_quota_test.go`: the routes, refresh and its failure, methods and auth.
- `web/console-nsh/tests/stats-coder-quota.test.tsx`: the helpers, the block, refresh, failures, and when it is hidden.
