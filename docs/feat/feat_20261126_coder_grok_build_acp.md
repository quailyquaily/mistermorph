---
date: 2026-11-26
title: "Coder: Grok Build (grok) as a fourth coder, over ACP"
status: planned
---

# Coder: Grok Build (grok) as a fourth coder, over ACP

**Planned. Nothing in this document is implemented.** The `coder` tool supports `codex`, `claude` and `agy` today; `coder=grok` is rejected as `unsupported coder: grok` (`agent/coder_tool.go`, `internal/codersessions/sessions.go`). The user-facing docs and the config template keep saying three coders until the implementation lands.

Follows [`feat_20261116_coder_sessions_everywhere.md`](feat_20261116_coder_sessions_everywhere.md) (the session path every coder uses), [`feat_20261113_coder_usage_quota.md`](feat_20261113_coder_usage_quota.md) and [`feat_20261115_coder_usage_console_and_chart.md`](feat_20261115_coder_usage_console_and_chart.md).

## Goal

Run xAI's Grok Build CLI (`grok`) as a coder beside Codex, Claude Code and the Antigravity CLI: `coder=grok`, a session per Console conversation or per run, approvals and questions in the Console, the run's usage in `usage.db`.

It runs on the interface Grok Build documents for host programs, `grok agent stdio` (the Agent Client Protocol, JSON-RPC over stdin and stdout), which is within the coder's rule: MisterMorph never reads a CLI's credentials, never calls its service, and never reads its interactive screen.

## Evidence

What this plan rests on, by how well it is known. No `grok` was installed, signed in or run for this document.

### Documented by xAI (read 2026-11-26)

Pages: <https://docs.x.ai/build/cli/headless-scripting> (H), <https://docs.x.ai/build/cli/reference> (R), and the user guide in the public repository, `crates/codegen/xai-grok-pager/docs/user-guide/` of <https://github.com/xai-org/grok-build>: `15-agent-mode.md` (A), `14-headless-mode.md`, `17-sessions.md`, `19-plan-mode.md`, `22-permissions-and-safety.md`. None of the pages carries a version or a date.

- `grok agent stdio` runs Grok as an ACP agent, JSON-RPC on stdin and stdout (H, R, A). The examples write one JSON message per line.
- Agent options go between `agent` and the mode: `grok agent --always-approve stdio` (A). Options: `-m/--model`, `--always-approve` (alias `--yolo`), `--reauth`, `--agent-profile <PATH>`, `--leader` / `--no-leader` (A).
- `--leader` connects to "a shared leader process"; leader mode is refused when a sandbox profile other than `off` is requested (A). The default is not stated.
- `--no-auto-update` is recommended for `grok agent stdio` in scripts (H).
- `initialize` takes `protocolVersion: 1` and `clientCapabilities`; the response has `authMethods`, each with an `id` (H). Ids in the example: `xai.api_key` (used when `XAI_API_KEY` is set) and `cached_token` (after a local `grok login`).
- `authenticate` takes `{ methodId, _meta: { headless: true } }` (H).
- `session/new` takes `{ cwd, mcpServers }` and returns `sessionId`; optional `_meta` fields are `rules`, `systemPromptOverride`, `agentProfile`, `yoloMode` and `autoMode` (H, A). `_meta.yoloMode: true` is always-approve for that session; hooks and deny rules still apply (A).
- `session/prompt` takes `{ sessionId, prompt: [{ type: "text", text }] }`; its response has `stopReason`. The answer's text comes in `session/update` notifications, not in the response (H).
- `session/update` kinds listed: `agent_message_chunk`, `agent_thought_chunk`, `tool_call` (title, kind, status, input), `tool_call_update`, `plan` (A). The examples read `update.content.text` and `update.title`.
- `session/set_config_option` sets `model` and `reasoning_effort`; `session/load` responses carry `configOptions` (A).
- When a session is not always-approve the agent "may request tool execution approval" (A). The request's shape is not shown.
- Extension methods live under `x.ai/`: `x.ai/fs/*`, `x.ai/git/*`, `x.ai/terminal/*`, `x.ai/session/*`, `x.ai/auth/*` (`get_url`, `submit_code`) and others, with notifications such as `x.ai/session_notification` and `x.ai/session/update`. The list is called non-exhaustive and "may expand across releases" (A).
- `ask_user_question` and `exit_plan_mode` are tools of the agent: the first asks the user, the second presents the plan for approval (`19-plan-mode.md`). The pages do not say how either reaches an ACP client.
- Permission modes: `default` (ask), `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions` (`22-permissions-and-safety.md`). Global flags include `--no-plan`, `--no-subagents`, `--sandbox <PROFILE>`, `--allow` and `--deny` (R); whether they apply to `grok agent` is not stated.
- Sign-in: `grok login` (`--device-auth` for machines without a browser), `grok logout`; `XAI_API_KEY` for CI (H, R). Credentials are cached in `~/.grok/auth.json`; `GROK_HOME` moves `~/.grok` (`14-headless-mode.md`).
- Sessions are kept under `~/.grok/sessions/<encoded-cwd>/<session-id>/` (`17-sessions.md`).
- `grok usage <session-id> [turn]` prints a session's usage as JSON (`17-sessions.md`). The headless `-p` output has `usage`, `modelUsage` and `total_cost_usd`.
- No command that reports a subscription quota or its windows is documented. `/usage` in the interactive screen shows credits and billing, and the coder never reads a screen.
- `grok version` prints the version (R).

### The ACP specification (read 2026-11-26, <https://agentclientprotocol.com/protocol/>)

What the standard says, which an agent may or may not follow:

- `stopReason` is one of `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- `session/cancel` is a notification. The client must answer every pending `session/request_permission` with `{ outcome: { outcome: "cancelled" } }`; the agent must then answer the `session/prompt` with `stopReason: "cancelled"`.
- `session/request_permission` has `sessionId`, `toolCall` and `options` (`optionId`, `name`, `kind`: `allow_once`, `allow_always`, `reject_once`, `reject_always`); the answer is `{ outcome: { outcome: "selected", optionId } }` or `cancelled`.
- `session/load` needs the `loadSession` capability and replays the whole conversation as `session/update` notifications before it answers. `session/resume` needs `sessionCapabilities.resume` and replays nothing.
- A request that needs a sign-in fails with error `-32000`, "Authentication required".
- The `session/prompt` response has no usage field. A `usage_update` session update carries `used`, `size` and an optional `cost`.
- Custom methods start with an underscore (`_com.example/...`). The Grok guide names its extensions `x.ai/...`, without one.

### Reported by an earlier reading of the source, not confirmed here

An earlier investigation read a snapshot of the Grok Build source at version 1.0.45. GitHub's code search needs a sign-in, so this document could not confirm these points, and the pages above do not cover them:

- The agent's question and plan approval reach an ACP client as the requests `x.ai/ask_user_question` and `x.ai/exit_plan_mode`.
- The `session/prompt` result carries the prompt's usage in `_meta`.
- With a leader process, the work and the commands it starts may run outside the `grok agent stdio` process the host started.
- The workspace pins the `agent-client-protocol` crate at 0.10.4 with its `unstable` feature (confirmed in `Cargo.toml` on 2026-11-26), so parts of the protocol may differ from the published specification.

### Not known

- The current release and what changed since 1.0.45. The repository has no releases or tags, and the changelog pages are not reachable (`docs.x.ai/build/changelog` and `CHANGELOG.md` in the repository answer 404).
- What `initialize` advertises: `loadSession`, `sessionCapabilities`, prompt capabilities, the full `authMethods`.
- Whether a `session/new` works without `authenticate` when a sign-in is cached, and what a missing sign-in looks like (the error code and text, or a wait).
- Whether a session that is not always-approve sends `session/request_permission` to a client on stdio, or denies the action on its own. The permissions page says only that in a non-interactive session an action that auto mode does not allow "fails and is reported to the model".
- The exact names, parameters and answers of the question and plan requests.
- The usage fields, where the model's name comes from, and whether `grok usage` works offline.
- Whether `session/cancel` stops the commands the agent started, and whether leader mode is on by default.
- Install directories on each system, and behaviour on macOS and Windows.

## The spike comes first

Step one of the implementation is a protocol spike against an installed `grok`, with the version from `grok version` written down. Nothing below is built before its findings are recorded in this document, and where they differ from the plan, the plan changes.

A small throwaway client talks to `grok agent stdio` in a scratch folder with a throwaway `HOME` where the test allows it, and records the JSON lines of:

1. **Handshake:** `initialize` and its full response (capabilities, `authMethods`).
2. **Sign-in:** signed in with `grok login`, with `XAI_API_KEY`, and with neither. Which `authenticate` call each needs, and the exact error, or wait, of the missing sign-in.
3. **A plain task:** message chunks, thought chunks, tool calls and their updates, the `session/prompt` result with its `stopReason` and `_meta`.
4. **Approvals:** in a session that asks, whether `session/request_permission` arrives, its options, and what allow and reject do to the task. The same with `--always-approve` and with `_meta.yoloMode`.
5. **Questions:** a task that makes the agent call `ask_user_question`: the request and the answer it accepts.
6. **Plan mode:** a task that plans: the `plan` updates, the exit request, approve and reject, and what `--no-plan` does to `grok agent`.
7. **Cancel:** `session/cancel` during a long shell command: the `stopReason`, whether the command and its children stop, and the same check after killing the process group instead. Both with `--leader`, `--no-leader` and neither.
8. **Recovery:** after a killed process, `session/resume` or `session/load` with the old id, by capability; what `session/load` replays; an unknown session id.
9. **Failures:** a model error, a tool error, a refusal, a turn limit: how each ends the prompt.
10. **Usage:** every place a token count, cost or model name appears, and `grok usage <session-id>` beside them.
11. **Quota:** confirm that no command reports it without the interactive screen.

The recorded lines, sanitized, become the stand-in CLI's script for the tests.

Only sanitized lines are kept. Before anything recorded is saved outside the scratch folder (as a test fixture, in this document, in the item or in a commit), it is redacted: no API key, OAuth or cached token, authorization header, sign-in URL or code, account id or email, and no user content (real prompts, file contents, paths under the user's home, host or user names). Ids are replaced with fixed placeholders and texts with short neutral ones. The spike's tasks are synthetic and run in an empty scratch folder; `~/.grok/auth.json` is never read or copied. The raw capture is deleted when the spike ends.

## Design

### Shape

One new file, `internal/codersessions/grok.go`, with a `(*session).grok` method beside `agy`, `codex` and `claude`. It reuses what the package already has and changes none of it:

| Need | Reused |
|---|---|
| Process, JSON lines, requests, replies, notifications | `rpc.go` (`startRPC`, `call`, `notify`, `reply`) |
| One process per scope and coder, reuse, busy check, reset, close | `sessions.go` (`Sessions.Run`) |
| Reaping, process group, stderr tail | `rpc.watch`, `coder_process_*.go`, `exit_*.go` |
| Questions, notes, progress | `ask`, `note`, `progress` and `Request` |
| Scope, the Console's right to ask | `taskruntime.CoderSessionRunner` |
| Environment and lookup | `shellenv.CoderEnv` |

The Antigravity backend also speaks ACP, in 205 lines. The Grok backend does not share code with it and no common ACP layer is extracted first: two clients whose agents differ in sign-in, extensions, usage and cancellation are not enough to know what such a layer should hold. `claude.go`, `codex.go` and `agy.go` are not rewritten.

For comparison, as the code stands:

| | Process | Start, reopen | Task, stop | Approvals | Own questions |
|---|---|---|---|---|---|
| Claude Code | `claude -p` with JSON streams in and out | `--session-id <uuid>`, `--resume <uuid>` | a user line on stdin; no interrupt, the process is closed | `control_request` `can_use_tool` | the same request with `AskUserQuestion` |
| Codex | `codex app-server` | `thread/start`, `thread/resume` | `turn/start`, `turn/interrupt` | `item/*/requestApproval` | `item/tool/requestUserInput` |
| Antigravity | `agy acp` | `session/new`; `session/resume`, else `session/load` | `session/prompt`, `session/cancel` | `session/request_permission` | none handled: any other request fails the task |
| Grok Build (planned) | `grok agent stdio` | `session/new`; `session/resume` or `session/load`, by capability | `session/prompt`, `session/cancel` | `session/request_permission` | `x.ai/ask_user_question`, `x.ai/exit_plan_mode` (unverified candidate names) |

### Command line

`grok agent --no-leader stdio`, with `--always-approve` before `stdio` in a bypassed session, and `--no-auto-update` where the installed CLI accepts it there. `--no-leader` keeps the work in the process the session owns, so that closing it stops the work; the spike confirms this and that a sandbox profile does not conflict.

### Handshake and sign-in

1. `initialize` with `protocolVersion: 1`, no file-system or terminal client capabilities (the agent uses its own tools), within the 30 seconds the other backends give their start.
2. The capabilities are kept for the reopen below.
3. Sign-in uses only a method the response advertises: `xai.api_key` when `XAI_API_KEY` is in the coder's environment (it is there only when the user lists it in `tools.bash.injected_env_vars`), else `cached_token`, with `_meta.headless: true`.
4. A missing sign-in (no usable method, a failed `authenticate`, or an authentication error from `session/new`, `session/resume`, `session/load` or `session/prompt`) fails the task at once with `grok is not signed in: run grok login in a terminal, then try again`, sets `Run.NotSignedIn`, and closes the process. The backend never opens a browser, never calls `x.ai/auth/*`, never passes `--reauth`, and never reads `~/.grok/auth.json`.

`HOME` is in the coder's environment, so a sign-in under `~/.grok` is found. `GROK_HOME` and `XAI_API_KEY` reach the CLI only when listed in `tools.bash.injected_env_vars`.

### Sessions

- New: `session/new` with `cwd` and an empty `mcpServers`.
- Reopen, after the process was closed (a failed or cancelled task, a crash, a changed approval setting), by what `initialize` advertised: `session/resume` when `sessionCapabilities.resume` is there; else `session/load` when `loadSession` is true; else a new session.
- What `session/load` replays is history: it is neither the new task's answer, nor notes, nor progress.
- When the session cannot be reopened (no capability, or the CLI does not know the id), a new session starts and a note says the earlier conversation was not carried over. The task does not fail for it, and the next tasks do not fail again.
- Nothing here promises a conversation kept across a process restart. Whether it is kept depends on the installed CLI, and the docs say so.

### A task

`session/prompt` with one text block. While it runs:

- `agent_message_chunk`: text blocks are appended to the answer in the order they come. A block that is not text adds nothing. Updates of another session id are ignored.
- What the agent wrote before a tool call is handed over as one note, whole, as the other backends do.
- `agent_thought_chunk`: not shown and not part of the answer; the step label is `thinking`.
- `tool_call`, `tool_call_update`: a progress line from the kind and title when the title is new.
- `plan`: the step label `planning`.
- An unknown update kind and an unknown notification are ignored.

The task ends with the `session/prompt` response:

| `stopReason` | Outcome |
|---|---|
| `end_turn` | success; the answer is the accumulated text |
| `cancelled` | failed (cancelled) |
| `max_tokens`, `max_turn_requests`, `refusal` | failed, with the reason |
| anything else, or none | failed, with the value |
| a JSON-RPC error, or the process ending | failed, with the error and the end of stderr |

A failed task keeps the text written so far as its output, with the failure as its error. Only `end_turn` is a success: an empty answer after `end_turn` gets a fixed line saying Grok finished without a text reply, never an earlier task's text.

### Approvals and questions

Who may be asked is decided where it is today, and this change adds no new rule: only the Console's local runtime sets `CoderCanAsk`; every other run (channels, cron, heartbeat, `run`, `chat`) starts its sessions with approvals bypassed, and a question the CLI asks there fails the task with the question as its error (`internal/channelruntime/taskruntime/coder_sessions.go`, `codersessions.ask`).

| | Console conversation | Console with `tools.coder.bypass_approvals.grok` | Any other run |
|---|---|---|---|
| Start | `grok agent --no-leader stdio` | with `--always-approve` | with `--always-approve` |
| `session/request_permission` | a question card with the agent's options, choices only | not expected; see below | not expected; see below |
| The agent's question | a question card | a question card | the task fails with the question as its error |
| Plan approval | a card with the plan: approve, or reject | approved, with the plan as a note | approved, with the plan as a note |

- The card's choices are the options the agent sent, by their names; the chosen option's id is the answer. Nothing is remembered on MisterMorph's side.
- A permission request in a bypassed session is unexpected, since the CLI was started not to ask. It is never granted silently: it is answered with the option of kind `allow_once` and a note names the tool call; `allow_always` is never chosen for the user; when there is no `allow_once` option the task fails with the request's title.
- A plan approval is an approval, so a bypassed session approves it, and the plan is written to the notes. A question is not an approval, so it is still asked in the Console and still fails the task elsewhere.
- Any other request from the agent that expects an answer (an `x.ai/*` method this backend does not know, a file-system or terminal request) is answered with JSON-RPC error `-32601` and fails the task with the method's name. Nothing unknown is ever answered with a success.
- `x.ai/ask_user_question` and `x.ai/exit_plan_mode` are unverified candidate names from the earlier source reading; the names and shapes actually used are taken from the spike. Handling the agent's question and its plan approval in the Console is required, not optional. If the installed CLI does not send them to an ACP client under these or other names, or sends them in a form that cannot meet the Console question and plan acceptance safely, that is a blocker: the findings are recorded, the implementation stops, and the owner decides. The rows are not dropped, the scope is not reduced without that decision, and no doc or tool description claims a capability the installed CLI does not have.

### Cancel

When the task's context ends (Stop, a deadline, a reset, the runtime closing):

1. Pending permission, question and plan requests are answered as cancelled.
2. `session/cancel` is sent.
3. The backend waits a short, fixed time for the `session/prompt` response, so the session is left in a state it can be reopened from.
4. `Sessions.Run` closes the process and kills its process group, as for every backend.

The task ends as cancelled, not as done, whatever the CLI answered. The risk is work outside the process group: a leader process, or commands the agent detached. `--no-leader` is the planned answer, and the spike's cancel check decides whether more is needed; if commands survive, the implementation stops and the finding is recorded here before anything ships.

### Usage

- The source is whatever the installed CLI reports for one prompt, settled by the spike: the `session/prompt` result's `_meta`, a `usage_update`, or `grok usage <session-id>` if it is local and cheap.
- Parsing assumes no schema: a field that is missing, renamed or of another type records no usage for the task and never fails it. No number is worked out from a running total unless the spike shows the totals and their resets.
- Rows go to `usage.db` under a host of Grok's own (`grok-build`), operation `coder`, with the model the CLI names, or `grok` when it names none. They are priced from the pricing catalog; a model without a price keeps its tokens and no cost. A cost the CLI reports is used only as the other coders' is.
- A cancelled task and a task whose process died record what was reported, or nothing.

### Quota

Grok Build documents no way to read a subscription quota outside its interactive screen, so none is read, stored or shown:

- A Grok run's result and activity carry its usage line without a quota part.
- `POST /stats/coder/quota/refresh` starts no `grok` process, and reports neither a quota nor an error for it.
- The quota read must never fall through to another coder's reader. Today `readCoderQuota` (`internal/daemonruntime/server_routes_coder_quota.go`) runs Codex's reader for any backend that is not `claude` or `agy`, and `coderusage.Host` returns `codex-cli` for any backend it does not know; both get an explicit Grok case.
- The Console's Coding agents dialog keeps its three sections.

If a later Grok release documents a quota command, that is a separate change.

### Where the fourth coder is named

| Place | File |
|---|---|
| Tool enum, description, parameter check | `agent/coder_tool.go`, `cmd/mistermorph/tools.go` |
| Dispatch (today `default:` runs agy) | `internal/codersessions/sessions.go` |
| Backend names, usage host | `internal/coderusage/usage.go`, `recorder.go` |
| Quota routes | `internal/daemonruntime/server_routes_coder_quota.go` |
| `tools.coder.bypass_approvals.grok` | `internal/configdefaults/defaults.go`, `internal/configsettings/fields.go`, `cmd/mistermorph/consolecmd/runtime_support.go`, `agent/engine_tools.go`, `web/console-nsh/lib/core/config-field-groups.js`, `assets/config/config.example.yaml` |
| "Still working" notices | `internal/channelruntime/taskruntime/coder_progress_notification.go` |
| Default install directories | `internal/shellenv/coder_env.go`, once the installer's directories are checked |
| Opt-in test | `internal/codersessions/installed_test.go` |

### Tests

- A stand-in `grok` in `internal/codersessions` that replays the spike's lines, as the stand-ins of the other three do: handshake and both sign-in methods; missing sign-in; two tasks on one process; chunks, notes and progress; each `stopReason`; a permission allowed and rejected; a question and a plan in the Console, bypassed and outside it; an unknown request; cancel with a pending request; a dead process; reopen by `session/resume`, by `session/load` with its replay, and with neither; usage present, absent and malformed.
- The existing tests of the three backends pass unchanged.
- Quota routes: a refresh with `grok` installed starts no process for it and runs no other coder's reader.
- Opt-in, against the installed and signed-in CLI: `MISTER_MORPH_CODER_SESSION_TEST=grok`.

## Docs when it is built

The implementation updates, in the same change: `docs/tools.md`, `web/vitepress/docs/guide/built-in-tools.md`, `subagents.md` and `config-reference.md`, `assets/config/config.example.yaml`, the tool description, and this document (status, the spike's findings, the version it was built against). Until then they name three coders.

## Not in this plan

- A shared ACP layer for agy and Grok.
- Grok's WebSocket modes (`grok agent serve`, `grok agent headless`), its `-p` headless mode, MCP servers handed to the session, model or reasoning-effort selection.
- A subscription quota for Grok.
- Sessions kept per chat outside the Console, and approvals there.
