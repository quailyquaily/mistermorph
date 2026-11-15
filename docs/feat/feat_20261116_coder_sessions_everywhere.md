---
date: 2026-11-16
title: "Coder: one session path per CLI, in every runtime, and no terminal"
status: in_progress
---

# Coder: one session path per CLI, in every runtime, and no terminal

Follows `feat_20260616_coder_tool_direct_cli.md` (the one-shot runs), `feat_20261031_claude_controlled_terminal.md` (the Console's terminal sessions), `feat_20261113_coder_usage_quota.md`, `feat_20261115_coder_agy.md` and `feat_20261115_coder_usage_console_and_chart.md`.

## Where this stands

| CLI | Target | State |
|---|---|---|
| Codex | `codex app-server` | built |
| Antigravity CLI (`agy`) | `agy acp` | built |
| Claude Code | `claude -p` with JSON streams | **not built**: it still has the Console PTY and the one-shot run |

The shared session code, the scopes and the approval rule are built with the first two. What is left is in [Remaining work](#remaining-work).

## Problem

The `coder` tool ran each CLI in two ways, and which one a task got depended on where it came from.

| | Console chat (macOS, Linux) | Everything else (channels, cron, heartbeat, `run`, Windows) |
|---|---|---|
| Claude Code | interactive `claude` in a PTY, kept per conversation | `claude -p <task> --output-format stream-json --dangerously-skip-permissions`, one process per call |
| Codex | interactive `codex` in a PTY, kept per conversation | `codex exec --dangerously-bypass-approvals-and-sandbox --json`, one process per call |
| agy | one-shot | one-shot |

So there were two readers of each CLI's output (the JSON stream, and the screen with the session file), two ways to count usage, two ways to read Claude Code's quota, and a switch between them in `coderTool.Execute` and `taskruntime`. A fix to one path did not reach the other: FT130 existed only because Console runs recorded no usage while one-shot runs did.

The terminal path also reads the CLIs' interactive screens, which the rule below does not allow.

## Goals

1. **Simpler:** one way to run each CLI, the same in every runtime.
2. **Within the rule:** the coder takes only what the CLIs themselves report over an interface made for a host program.

### The rule

From `feat_20261113_coder_usage_quota.md`: MisterMorph never reads the CLIs' credentials, never calls their services, and never reads their interactive screens.

| Way | Reads | Within the rule |
|---|---|---|
| A PTY with the interactive CLI | the screen | no |
| `claude -p` with JSON streams | stdout of the CLI's non-interactive mode | yes |
| `codex app-server` | JSON-RPC on stdout | yes |
| `agy acp` | ACP on stdout | yes |

One exception stays, for a stated reason: Codex's usage is still read from its rollout files (see [Codex](#codex)). That is a file the CLI writes, not a screen.

## Decisions

1. **One way per CLI, in every runtime** (Console, Telegram, Slack and the other channels, cron, heartbeat, `run`, `chat`), each over stdio:
   - Claude Code: always `claude -p`.
   - Codex: `codex app-server`.
   - agy: `agy acp`.
2. **No terminal.** Nothing reads a CLI's screen. The PTY code goes.
3. **Approvals only in the Console.** A Console chat's session asks the user. Every other run starts its session with approvals bypassed, which is what those runs did before.
4. **Sessions stay.** A Console conversation keeps its coder between tasks. What changes is how the process is talked to.

With the terminal gone, all three run the same way on Windows, macOS and Linux. Windows was not checked in this change.

## One interface

The `coder` tool sees one thing: a session that takes a task.

```
scope + backend + cwd ──► open or reuse a session ──► run(task) ──► answer, usage, quota
                                                        │
                                                        ├─ progress and notes
                                                        └─ questions (when the run can ask)
```

- `internal/codersessions` owns the sessions: `Sessions.Run(ctx, scope, Request)`, `Reset(scope)`, `Close()`. A session is one CLI process talking JSON lines over stdin and stdout (`rpc.go`), with a backend per CLI (`codex.go`, `agy.go`).
- `agent.WithCoderSessions` hands the runner to the engine; `taskruntime.CoderSessionRunner` binds a run's scope and whether it may ask. The runtime owns the sessions and closes them with itself.
- `codersessions.Request` carries the task, the folder, the command and environment (from the coder environment builder, as before), `Ask`, `Progress`, `Note`, `Process` and `Report` (the run's usage and quota).

### Scope: how long a session lives

| Run | Scope | Ends |
|---|---|---|
| Console chat | the conversation | conversation reset or deleted, working folder changed, runtime closed |
| Any other run | the run itself | when the run ends |

- A cron job that calls `coder` three times in one run has one session for the three calls. Nothing outlives a run outside the Console, so there are no idle processes to collect.
- Telegram and Slack chats get a session per run. Keeping one per chat (with an idle timeout) is left for later.
- A session takes one task at a time; a second one is refused while it is busy.
- A task that fails or is cancelled closes the process. The session keeps its id, and the next task of the scope reopens it.
- A changed `bypass_approvals` setting reopens the process before the next task.

### Approvals and questions

| | Console chat | Any other run |
|---|---|---|
| Codex | approval policy `on-request`, sandbox `workspace-write`; requests become question cards | policy `never`, sandbox `danger-full-access` |
| agy | permission requests become question cards | `--dangerously-skip-permissions` |
| Claude Code (to build) | permission requests become question cards | `--dangerously-skip-permissions` |

- `tools.coder.bypass_approvals.codex`, `.claude` and the new `.agy` turn approvals off in the Console too. Outside the Console they change nothing.
- Whether a run asks is set by the Console's local runtime (`CoderCanAsk`). It does not follow from the run having a question channel: Telegram and Slack have one and are bypassed.
- A question the CLI itself puts to the user is shown as a card in the Console. In any other run the task fails with the question as its error and the process is closed; the agent reads it and can put it to the user in its own way.

## Codex

One `codex app-server` process per session, JSON-RPC over stdio. Built against Codex CLI 0.169.0.

| Need | App server |
|---|---|
| Start, reopen | `thread/start`, `thread/resume` |
| Send a task, stop it | `turn/start`, `turn/interrupt` |
| End of a task | `turn/completed` |
| Answer and progress | the agent message items and deltas, `item/started`, `item/completed` |
| Approvals | `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`, `item/permissions/requestApproval` |
| The CLI's own question | `item/tool/requestUserInput` |
| Quota | `account/rateLimits/read`, asked of the session's own server after a task |

- **Usage** is still read from the thread's rollout files, by an incremental reader that stays with the session over a process restart (`coderterm.CodexUsageReader`). The reason: rows are priced from the catalog by the model each response actually used, response by response, sub-agents included, and the app server's token events give only the thread's totals. Those events are the fallback when the rollouts cannot be read; a session that fell back stays on them, so a late file write is not counted twice.
- The refresh button keeps its short-lived server (`coderusage.ReadCodexQuota`), since no session may be open.

Removed: the Codex PTY backend (`coderterm/codex.go`: the `/status` read, the screen parser, the rollout turn reader) and the `codex exec` run with its stream parsing.

## Antigravity CLI

One `agy acp` process per session, ACP over stdio. Built against 1.5.9.

| Need | ACP |
|---|---|
| Start, reopen | `session/new`; `session/resume`, else `session/load` |
| Send a task, stop it | `session/prompt`, `session/cancel` |
| Answer and progress | `session/update` (`agent_message_chunk`, `tool_call`, `tool_call_update`, `plan`) |
| Approvals | `session/request_permission` |
| End of a task, usage | the `session/prompt` result: `stopReason`, and `usage` (input, output, cache read, cache write and thought tokens) |

- agy now has sessions: in the Console it keeps its conversation between tasks and asks for approval, as the other two do.
- Usage rows keep the model `agy` and no cost: the result gives a prompt's totals, not single requests that could be priced.
- Not signed in: the task fails at once with `agy is not signed in: run agy once in a terminal and sign in with a Google account, then try again`, and no quota is read.
- Quota: `agy -p /usage --output-format json` after a task and for the refresh button, as before.

Removed: `agent/coder_agy.go`, the one-shot run and its stream parsing.

## Claude Code

**Not built yet.** Today the Console still runs it in a PTY (`internal/coderterm`, through `agent.WithCoderTerminal`) and every other run uses the one-shot `claude -p <task>`.

### Target

One `claude -p` process per session, JSON lines in and out, as a third backend in `internal/codersessions`:

```text
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-prompt-tool stdio \
  --session-id <uuid> --permission-mode default           # Console
  --session-id <uuid> --dangerously-skip-permissions      # every other run
  --resume <uuid> …                                       # reopened
```

### What a real run showed

Checked against Claude Code 2.1.325 on 2026-11-16 with four small tasks.

| Need | Stream | Seen |
|---|---|---|
| Send a task | `{"type":"user","message":{"role":"user","content":"…"}}` on stdin; the process stays up for the next | yes, two tasks on one process |
| Answer, progress | `assistant` messages and their tool uses, as the one-shot run reads them | yes |
| End of a task | a `result` line per task (`subtype`, `is_error`, `result`, `num_turns`) | yes |
| Approvals | a `control_request` with `request.subtype` `can_use_tool` (`tool_name`, `input`, `description`, `tool_use_id`) | yes |
| Answer to it | `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"allow","updatedInput":{…}}}}`, or `{"behavior":"deny","message":"…"}` | yes, both |
| The CLI's own question | the same request with `tool_name` `AskUserQuestion`, `input.questions` (question, header, options) and `requires_user_interaction`; answered with `allow` and `updatedInput.answers` (`{question: answer}`) | yes |
| Usage of a task | `result.model_usage_since_last_result`: per model the tokens, cache reads and writes, and `costUSD` | yes |
| Quota | `rate_limit_event`, as in the one-shot run | yes |
| Reopen | `--resume <uuid>` with `-p` goes on in the same session and has its context | yes |

Three things to know:

- `--permission-prompts host` alone does not ask: without `--permission-prompt-tool stdio` the action is denied and the model is told so.
- `result.modelUsage` and `total_cost_usd` are running totals of the process. A task's usage is `model_usage_since_last_result`.
- A denied action does not end the task: Claude Code goes on and says what it could not do. The `result` lists it in `permission_denials`.

Not seen yet: an interrupt of a running task (until it is, a cancelled task closes the process and the session is reopened, as for the other two), a question in a bypassed session, and a sub-agent's usage in `model_usage_since_last_result`.

### What follows from it

- Usage rows are as a one-shot run's: the CLI's own list price per model, marked estimated. The transcript reader and the pricing by responses are no longer fed by new rows.
- Quota: `rate_limit_event` during a task. The refresh button keeps `claude -p /usage --output-format json --no-session-persistence` (`coderusage.ReadClaudeQuota`), a local command that calls no model. The status line command and `statusline.json` go with the terminal.
- `--no-session-persistence` goes from task runs: the session must be on disk for `--resume`.
- Claude Code works as a coder on Windows again in the Console, as it does outside it.

## Remaining work

1. **Claude Code backend** in `internal/codersessions`: the process and its lines, the stream parsing moved from `coderStreamCollector.consumeClaude` (reset per task), permissions and questions through `Ask`, usage from `model_usage_since_last_result`, the quota from `rate_limit_event`.
2. **Remove Claude Code's two old paths:**
   - `agent.WithCoderTerminal`, `coderToolDeps.RunTerminal` and `RunCLI`, `runCoderCLI`, `buildCoderCLICommand` and the one-shot diagnostics in `agent/coder_tool.go`; the Claude Code branch in `coderTool.Execute`, so that all three go through `RunSessions`.
   - `taskruntime`: `CoderSessions` (the terminal ones), `coderTerminalReport` and the `coderterm.Supported` condition.
   - `internal/coderterm`: the PTY session, the Claude Code backend, its screen parser and transcript reader, and the Claude Code half of `usage.go`.
3. **What is left of `coderterm`** is Codex's rollout usage reader and the `Question` / `Answer` types `codersessions` uses. Move them to `codersessions` and delete the package, with the `creack/pty` and `charmbracelet/x/vt` dependencies and the `screen` files added to the ultraviolet replacement, if nothing else uses them.
4. **Keep for old rows:** `llm_requests.pricing_parts` and `llmstats.catalogCost`'s pricing by parts. Rows already written are still repriced when the catalog changes.
5. **Docs and config:** `docs/tools.md` (the Claude Code sentences of the `coder` paragraphs), `assets/config/config.example.yaml` (the comments on terminal sessions), the tool description. Mark `feat_20261031_claude_controlled_terminal.md` and Part 1 of `feat_20261115_coder_usage_console_and_chart.md` as superseded.

## Tests

Built, with stand-in servers (`internal/codersessions/sessions_test.go`): reuse of a session, permissions, questions, cancellation, failures, resume, usage and quota for Codex and agy. `installed_test.go` checks the installed Codex's schema and sends a minimal real request through each client (opt-in).

Not covered: a real permission denial through Codex or agy (the stand-ins exercise the answers).

To add with Claude Code:

- A stand-in `claude` replaying the captured lines: two tasks on one process with each one's answer and usage, a permission allowed and denied, the question tool, a bypassed session's flags and a question in it, a cancelled task, a process that died and the resume, the quota.
- `agent/coder_usage_test.go`: Claude Code's usage and quota arrive in one report and the rows in `usage.db`, through the session path.
- `internal/llmstats`: rows with pricing parts already in a file are still repriced after a catalog change.
- An opt-in run against the installed CLI: a task in a bypassed run-scoped session, and a second task that needs the first one's context.

## Not in this change

- Sessions kept per Telegram or Slack chat, and approvals there.
- Checking the three backends on Windows.
- Backfilling or changing rows already in `usage.db`.
