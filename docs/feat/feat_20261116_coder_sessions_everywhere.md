---
date: 2026-11-16
title: "Coder: one session path per CLI, in every runtime, and no terminal"
status: implemented
---

# Coder: one session path per CLI, in every runtime, and no terminal

Follows `feat_20260616_coder_tool_direct_cli.md` (the one-shot runs), `feat_20261031_claude_controlled_terminal.md` (the Console's terminal sessions), `feat_20261113_coder_usage_quota.md`, `feat_20261115_coder_agy.md` and `feat_20261115_coder_usage_console_and_chart.md`.

## Where this stands

| CLI | Target | State |
|---|---|---|
| Codex | `codex app-server` | built |
| Antigravity CLI (`agy`) | `agy acp` | built |
| Claude Code | `claude -p` with JSON streams | built |

All three coders go through one path, `Sessions.Run` in `internal/codersessions`, in every runtime. The terminal sessions and the one-shot runs are removed, with `internal/coderterm` and its PTY and terminal emulator dependencies. Nothing reads a CLI's screen.

Checked with stand-in CLIs that replay the lines of real runs. The installed CLIs are checked only by opt-in tests; see [Tests](#tests) for what was not checked against a real CLI.

## Problem

Before this change the `coder` tool ran each CLI in two ways, and which one a task got depended on where it came from.

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

- `internal/codersessions` owns the sessions: `Sessions.Run(ctx, scope, Request)`, `Reset(scope)`, `Close()`. A session is one CLI process talking JSON lines over stdin and stdout (`rpc.go`), with a backend per CLI (`codex.go`, `agy.go`, `claude.go`).
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
| Claude Code | `--permission-mode default`; permission requests become question cards | `--dangerously-skip-permissions` |

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

- **Usage** is still read from the thread's rollout files, by an incremental reader that stays with the session over a process restart (`codersessions.CodexUsageReader`, moved from `coderterm`). The reason: rows are priced from the catalog by the model each response actually used, response by response, sub-agents included, and the app server's token events give only the thread's totals. Those events are the fallback when the rollouts cannot be read; a session that fell back stays on them, so a late file write is not counted twice.
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

One `claude -p` process per session, JSON lines in and out (`internal/codersessions/claude.go`). Built against Claude Code 2.1.325.

```text
claude -p --input-format stream-json --output-format stream-json --verbose \
  --include-partial-messages --permission-prompt-tool stdio \
  --session-id <uuid> --permission-mode default           # a Console session that asks
  --session-id <uuid> --dangerously-skip-permissions      # every other run, and bypass_approvals.claude
  --resume <uuid> …                                       # reopened
```

| Need | Stream |
|---|---|
| Send a task | `{"type":"user","message":{"role":"user","content":"…"}}` on stdin; the process stays up for the next |
| Answer | the task's `result` line (`result`); when it has no text, the last message Claude Code wrote in the task |
| Progress | `system`, `stream_event`, `tool_progress`, and the tool uses and tool results of `assistant` and `user` messages |
| End of a task | its `result` line (`subtype`, `is_error`, `num_turns`) |
| Approvals | a `control_request` with `request.subtype` `can_use_tool` (`tool_name`, `input`, `description`, `tool_use_id`) |
| Answer to it | `{"type":"control_response","response":{"subtype":"success","request_id":"…","response":{"behavior":"allow","updatedInput":{…}}}}`, or `{"behavior":"deny","message":"…"}` |
| The CLI's own question | the same request with `tool_name` `AskUserQuestion` and `input.questions` (question, header, options); answered with `allow` and `updatedInput.answers` (`{question: answer}`) |
| Usage of a task | `result.model_usage_since_last_result`: per model the tokens, cache reads and writes, and `costUSD` |
| Quota | `rate_limit_event` |
| Reopen | `--resume <uuid>` |

### What a real run showed

Checked against Claude Code 2.1.325 on 2026-11-16 with four small tasks, before the backend was written: two tasks on one process, a permission allowed and denied, the `AskUserQuestion` request and its answer, `model_usage_since_last_result`, `rate_limit_event`, and `--resume` going on in the same session with its context.

Three things to know:

- `--permission-prompts host` alone does not ask: without `--permission-prompt-tool stdio` the action is denied and the model is told so.
- `result.modelUsage` and `total_cost_usd` are running totals of the process. A task's usage is `model_usage_since_last_result`.
- A denied action does not end the task: Claude Code goes on and says what it could not do. The `result` lists it in `permission_denials`.

The installed 2.1.325 accepts the command lines above (`--permission-mode default` is not in its `--help` list of choices, and is accepted), and writes nothing before its first task.

### How it behaves

- **A task's lines are its own.** The answer, the progress and the usage are collected per task. A task without a text reply answers `Claude Code finished this task without a text reply.`, never the text of the task before. Lines the process wrote after the previous task's result are taken off before the next task is sent; a quota among them is kept.
- **Progress** is a short label of what Claude Code is doing (`thinking`, `running a command`, `editing files`, …), said when it changes. **Notes** are what it said before going on working, and one line per tool use and tool result (cut at 1000 characters). A sub-agent's text (`parent_tool_use_id`) is neither the reply nor a note.
- **Permissions.** In a Console session that asks, a `can_use_tool` request is a card with `Allow once` and `Deny`. A denial answers `deny` and the task goes on. In a bypassed session the flag keeps Claude Code from asking; a request that comes anyway is allowed.
- **Questions.** `AskUserQuestion` is one card per question, with the options' labels as choices and room for an own answer, in a bypassed Console session too. In a run that cannot ask, the task fails with the question (and its options) as its error, and the process is closed.
- **Usage** rows are the CLI's own list price per model, marked estimated, as the one-shot run's were. A `result` line without `model_usage_since_last_result` records no usage: nothing is worked out from `modelUsage` or `total_cost_usd`. A task that is cancelled, or whose process dies, has no `result` line: what it used is not recorded.
- **Quota** is the last `rate_limit_event` of the task. The refresh button keeps `claude -p /usage --output-format json --no-session-persistence` (`coderusage.ReadClaudeQuota`), a local command that calls no model. The status line command and `statusline.json` went with the terminal.
- **Closing and reopening.** A cancelled or failed task, a dead process and a changed `bypass_approvals.claude` close the process (cancellation kills its process group; no interrupt is sent over the stream). The next task of the scope starts `--resume <uuid>` with the session id the `result` lines reported. A session Claude Code never replied in may not be on disk, and a reopened process that exits without a line could not open it: both start over with a new session id instead of failing every later task.
- `--no-session-persistence` is not used for tasks: the session must be on disk for `--resume`. Sessions of runs outside the Console therefore stay in Claude Code's own session list.
- A process's last words on stderr are added to the error when it dies.
- Claude Code works as a coder on Windows again in the Console, as it does outside it (not checked, see below).

Removed with it: the Console PTY (`internal/coderterm`: the session, Claude Code's screen parser, transcript reader and transcript usage), the one-shot run (`runCoderCLI`, its stream collector and its diagnostics folders under `file_cache_dir/coder`), `agent.WithCoderTerminal`, and `coderusage.ParseClaudeStatusLine`. `creack/pty`, `charmbracelet/x/vt` and the `screen` files of the ultraviolet replacement are gone from the module.

## What stays for old rows

`llm_requests.pricing_parts` and `llmstats.catalogCost`'s pricing by parts stay. Codex's rows still use them. Claude Code's terminal sessions no longer write such rows, and the ones already in a `usage.db` are still priced again, request by request, when the catalog changes.

## What changed for users

- Claude Code in a Console chat no longer shows its terminal's status; it shows the same progress labels and notes as the other two coders, and approval cards come from its permission requests.
- The diagnostics folders of one-shot runs (`file_cache_dir/coder/claude-*`) are no longer written. Existing ones are left where they are.
- A program that embeds the engine without `agent.WithCoderSessions` gets `coder sessions unavailable` for Claude Code too; before, Claude Code fell back to the one-shot run.
- The Console's settings show the Antigravity toggle of `tools.coder.bypass_approvals` beside the other two.

## Remaining work

The five items this section listed are done: the Claude Code backend, the removal of its two old paths, the move of what was left of `coderterm`, the kept pricing by parts, and the docs and config. What is open:

1. Run the opt-in test against the installed Claude Code and settle the three points listed under [Tests](#tests) as not checked.
2. The items of [Not in this change](#not-in-this-change).

## Tests

With stand-in CLIs (`internal/codersessions`):

- `sessions_test.go`: reuse of a session, permissions, questions, cancellation, failures, resume, usage and quota, for all three backends.
- `claude_test.go`, a stand-in `claude` that writes the lines above: two tasks on one process with each one's answer, usage and quota, and a third without a reply; progress, notes and the reply from the last message; lines after a result; a permission allowed and denied; the question tool; a bypassed Console session's flags, a permission and a question in it; a question in a run that cannot ask; a cancelled task, a failed one and a process that died, each followed by the resume; a session that cannot be reopened; a changed approval setting.
- `codex_usage_test.go`: Codex's rollout usage reader, moved with it.

Elsewhere:

- `agent/coder_usage_test.go`: Claude Code through real sessions and a stand-in CLI: each task's usage and the quota in one report, the usage line of the result, and the rows in `usage.db` (the second task's row is its own usage, not the process's totals).
- `internal/coderusage`: `ClaudeTaskUsage`: `model_usage_since_last_result`, and no usage from `modelUsage` and `total_cost_usd` alone, over several tasks (also in `internal/codersessions`, on one process).
- `internal/llmstats`: rows with pricing parts already in a file are priced again after a catalog change, beside a session's row that keeps the CLI's cost.

Opt-in, against the installed CLIs (they use the signed-in account and its quota):

- `MISTERMORPH_TEST_CLAUDE=1 go test ./internal/codersessions -run TestInstalledClaudeSession`: a task in a bypassed run-scoped session, and a second task that needs the first one's context.
- `MISTER_MORPH_CODER_SESSION_TEST=codex` or `agy`: one minimal task through that backend; `MISTER_MORPH_CODEX_SCHEMA_TEST=1`: the installed Codex's app-server schema, without a model request (`installed_test.go`).

Not checked against a real CLI:

- The Claude Code backend as built. The lines it reads are the ones the real run above wrote, and the installed CLI accepts its command lines; the opt-in test was not run in this change.
- A question in a bypassed Claude Code session, a sub-agent's usage in `model_usage_since_last_result`, and whether `num_turns` counts a task or the process.
- A real permission denial through Codex or agy (the stand-ins exercise the answers).
- The Console's cards for Claude Code's permissions and questions, in a browser.
- Any backend on Windows.

## Not in this change

- Sessions kept per Telegram or Slack chat, and approvals there.
- Checking the three backends on Windows.
- Backfilling or changing rows already in `usage.db`.
- An interrupt of a running Claude Code task over the stream: a cancelled task closes the process, and the session is reopened.
- Recording what a cancelled Claude Code task used.
