# Grok Build as a fourth coder: `coder=grok` on `grok agent stdio` (ACP)

## factory · 2026-11-26 15:01
Owner request: support xAI's Grok Build CLI (`grok`) as a coder beside Codex, Claude Code and the Antigravity CLI. The owner approved the plan of the earlier investigation: one new thin backend, `internal/codersessions/grok.go`, on Grok's documented ACP mode `grok agent stdio`, reusing the package's process, session and progress code. `claude.go`, `codex.go` and `agy.go` are not rewritten, and no shared ACP layer is extracted first.

The design is in `docs/feat/feat_20261126_coder_grok_build_acp.md` (status `planned`; on `master` once the branch `docs/grok-coder-acp-plan-20261126` is merged). Documentation commit: `5189ef7a99d37977e7decbf5e7a26cf8b250ff19`, pushed on that documentation-only branch; it is not merged to master by this intake. This item is complete without it; read it for the evidence in full.

Nothing was installed, signed in or run to write this item. Every Grok fact below is marked by where it comes from. Step 1 is a spike against the real CLI, and its findings overrule this text where they differ.

### Today

- `coder` takes `codex`, `claude` or `agy`; anything else is `unsupported coder: <name>` (`agent/coder_tool.go:77` enum, `:236` check; `internal/codersessions/sessions.go:38`).
- Every coder runs through `Sessions.Run` (`internal/codersessions/sessions.go`): one process per scope and coder, JSON lines over stdin and stdout (`rpc.go`). Its `switch` sends `codex` and `claude` to their backends and everything else to `s.agy` (`default:`).
- The backends, as the code stands:
  - Claude Code (`claude.go`): `claude -p --input-format stream-json --output-format stream-json … --permission-prompt-tool stdio`, `--session-id <uuid>` then `--resume <uuid>`; a task is a user line on stdin and ends with its `result` line; approvals and `AskUserQuestion` arrive as `control_request` `can_use_tool`; no interrupt is sent, a cancelled task closes the process.
  - Codex (`codex.go`): `codex app-server`; `thread/start`, `thread/resume`, `turn/start`, `turn/interrupt`; approvals are `item/*/requestApproval`, questions `item/tool/requestUserInput`.
  - Antigravity (`agy.go`): `agy acp`; `session/new`, `session/resume` else `session/load` by capability, `session/prompt`, `session/cancel`; approvals are `session/request_permission`; any other request from the agent fails the task.
- Who may be asked (`internal/channelruntime/taskruntime/coder_sessions.go:15`): `BypassApprovals: !canAsk || request.BypassApprovals`. Only the Console's local runtime sets `CoderCanAsk` (`cmd/mistermorph/consolecmd/local_runtime.go:3042`). Every other run has approvals bypassed, and a question the CLI asks there fails the task with the question as its error (`codersessions.ask`, `sessions.go:137`). `tools.coder.bypass_approvals.<coder>` turns approvals off in the Console too; the CLI's own questions are still shown.
- Two places fall through to Codex for a coder they do not know, and must not for Grok: `readCoderQuota` (`internal/daemonruntime/server_routes_coder_quota.go:28`: `ReadCodexQuota` for anything that is not `claude` or `agy`) and `coderusage.Host` (`internal/coderusage/recorder.go:26`: `codex-cli`). The quota routes loop over `coderusage.Backends` (`internal/coderusage/usage.go:42`).

### Evidence

Documented by xAI, read 2026-11-26. No page carries a version or a date. Pages: <https://docs.x.ai/build/cli/headless-scripting>, <https://docs.x.ai/build/cli/reference>, and in <https://github.com/xai-org/grok-build> under `crates/codegen/xai-grok-pager/docs/user-guide/`: `15-agent-mode.md`, `14-headless-mode.md`, `17-sessions.md`, `19-plan-mode.md`, `22-permissions-and-safety.md`.

- `grok agent stdio` is an ACP agent, JSON-RPC on stdin and stdout, one message per line in the examples.
- Agent options go before the mode: `grok agent --always-approve stdio`. Options: `-m/--model`, `--always-approve` (`--yolo`), `--reauth`, `--agent-profile`, `--leader` / `--no-leader`. `--leader` connects to "a shared leader process"; the default is not stated. `--no-auto-update` is recommended for scripts.
- `initialize` with `protocolVersion: 1`; the response lists `authMethods`. The example uses `xai.api_key` when `XAI_API_KEY` is set and `cached_token` after `grok login`, calling `authenticate` with `{ methodId, _meta: { headless: true } }`.
- `session/new` with `{ cwd, mcpServers }` returns `sessionId`; `_meta.yoloMode: true` is always-approve for the session.
- `session/prompt` with `{ sessionId, prompt: [{ type: "text", text }] }`; the response has `stopReason`; the text comes in `session/update`.
- `session/update` kinds: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`.
- A session that is not always-approve "may request tool execution approval"; the request is not shown.
- Extensions are named `x.ai/...` (`x.ai/fs/*`, `x.ai/terminal/*`, `x.ai/auth/*`, `x.ai/session_notification`, …); the list is non-exhaustive and may grow.
- `ask_user_question` and `exit_plan_mode` are tools of the agent (a question to the user; the plan put up for approval). How they reach an ACP client is not documented.
- Sign-in: `grok login` (`--device-auth`), `XAI_API_KEY`; credentials in `~/.grok/auth.json`; `GROK_HOME` moves `~/.grok`; sessions under `~/.grok/sessions/`.
- `grok usage <session-id> [turn]` prints a session's usage as JSON. No command reports a subscription quota; `/usage` exists only in the interactive screen.
- `grok version` prints the version.

The ACP specification (<https://agentclientprotocol.com/protocol/>, read 2026-11-26), which the agent may or may not follow:

- `stopReason`: `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- `session/cancel` is a notification; the client must answer pending `session/request_permission` requests with `{ outcome: { outcome: "cancelled" } }`; the agent then answers the prompt with `cancelled`.
- Permission options have `optionId`, `name` and `kind` (`allow_once`, `allow_always`, `reject_once`, `reject_always`); the answer is `{ outcome: { outcome: "selected", optionId } }`.
- `session/load` (capability `loadSession`) replays the conversation as `session/update` before it answers; `session/resume` (capability `sessionCapabilities.resume`) replays nothing.
- A missing sign-in is error `-32000`.
- The prompt response has no usage field; a `usage_update` update has `used`, `size` and an optional `cost`.

Reported by the earlier reading of the 1.0.45 source, not confirmed for this item (GitHub code search needs a sign-in):

- The question and the plan approval reach the client as the requests `x.ai/ask_user_question` and `x.ai/exit_plan_mode`.
- The `session/prompt` result carries usage in `_meta`.
- With a leader process, work may run outside the process the host started.
- `Cargo.toml` pins `agent-client-protocol` 0.10.4 with `unstable` (this one was confirmed on 2026-11-26).

### Unknown

Each is settled by step 1 and written into the design document.

- The current version and what changed since 1.0.45 (no releases, no tags, the changelog pages answer 404).
- What `initialize` advertises (`loadSession`, `sessionCapabilities`, all `authMethods`).
- Whether `session/new` needs `authenticate` when a sign-in is cached; what a missing sign-in looks like.
- Whether a session that asks sends `session/request_permission` to a stdio client, and with which options.
- The names, parameters and answers of the question and plan requests; what `--no-plan` does to `grok agent`.
- The usage fields, the source of the model's name, and whether `grok usage` is local.
- Whether `session/cancel` stops the commands the agent started; whether leader mode is the default; whether `--no-leader` conflicts with anything.
- The installer's directories on each system; macOS and Windows.

### Step 1: protocol spike (before any product code)

Against an installed `grok`, signed in by the owner, with the version from `grok version` recorded. A throwaway client (not committed) drives `grok agent stdio` in a scratch folder and keeps the JSON lines of:

1. `initialize` and its full response.
2. Sign-in three ways: `grok login`, `XAI_API_KEY`, neither. The `authenticate` call each needs; the exact error or wait of the missing sign-in.
3. A plain task: chunks, thoughts, tool calls, the prompt result with `stopReason` and `_meta`.
4. Approvals: whether `session/request_permission` is delivered, its options, allow and reject; the same with `--always-approve` and `_meta.yoloMode`.
5. A question (`ask_user_question`): the request and the answer it accepts.
6. Plan mode: `plan` updates, the exit request, approve and reject, `--no-plan`.
7. Cancel during a long shell command: the `stopReason`, and whether the command and its children really stop, after `session/cancel` and after killing the process group; with `--leader`, `--no-leader` and neither.
8. Recovery: after a killed process, `session/resume` or `session/load` by capability, what load replays, an unknown session id.
9. Failures: a model error, a tool error, a refusal, a turn limit.
10. Usage: every token count, cost and model name, and `grok usage <session-id>`.
11. Quota: confirm nothing reports it outside the interactive screen.

Write the findings and the version into `docs/feat/feat_20261126_coder_grok_build_acp.md`. The recorded lines, sanitized, become the stand-in CLI's script.

Only sanitized lines are kept. Before anything recorded is saved outside the scratch folder (as a test fixture, in the design document, in this item or in a commit), it is redacted: no API key, OAuth or cached token, authorization header, sign-in URL or code, account id or email, and no user content (real prompts, file contents, paths under the user's home, host or user names). Ids are replaced with fixed placeholders and texts with short neutral ones. The spike's tasks are synthetic and run in an empty scratch folder; `~/.grok/auth.json` is never read or copied. The raw capture is deleted when the spike ends.

If a finding breaks a decision below (commands survive a cancel, approvals cannot reach the client, the question or the plan approval cannot reach the client, no usable sign-in without a browser), stop and report it in this item instead of building around it.

If no signed-in `grok` is available to the builder, do not build from the documents alone: say so in this item and leave it for the owner.

### Step 2: the backend

`internal/codersessions/grok.go`, a `(*session).grok` method, using `startRPC`, `rpc.call`, `notify`, `reply`, `ask`, `note`, `progress` as `agy.go` does.

Command: `grok agent --no-leader stdio`; `--always-approve` before `stdio` when `req.BypassApprovals`; `--no-auto-update` if the installed CLI accepts it there.

Handshake and sign-in:
- `initialize` (`protocolVersion: 1`, no fs or terminal client capabilities) within the 30 seconds the other backends allow.
- Use only an advertised method: `xai.api_key` when `XAI_API_KEY` is in `req.Env`, else `cached_token`, with `_meta.headless: true`.
- A missing sign-in, at any call, fails the task at once with `grok is not signed in: run grok login in a terminal, then try again`, sets `Run.NotSignedIn` and closes the process.
- Never open a browser, call `x.ai/auth/*`, pass `--reauth`, or read `~/.grok/auth.json`.

Sessions:
- `session/new` with `cwd` and empty `mcpServers`.
- Reopen by capability: `session/resume` if advertised, else `session/load` if `loadSession`, else a new session.
- Updates replayed by `session/load` are not the task's answer, notes or progress.
- A session that cannot be reopened (no capability, unknown id) starts a new one, with a note that the earlier conversation was not carried over. The task does not fail for it.

A task (`session/prompt`, one text block):
- `agent_message_chunk`: append text blocks in order; other block types add nothing; other session ids are ignored.
- Text written before a tool call becomes one note. Thought chunks are not shown.
- `tool_call`, `tool_call_update`: a progress line from kind and title when the title is new. `plan`: `planning`.
- Unknown update kinds and unknown notifications are ignored.
- Only `stopReason` `end_turn` is a success. `cancelled`, `max_tokens`, `max_turn_requests`, `refusal`, any other value, a JSON-RPC error and a dead process are failures that keep the text so far as output.
- `end_turn` with no text answers a fixed line (as `claudeNoTextReply`), never an earlier task's text.

Approvals and questions. No new rule about who may be asked; the table is today's policy applied to Grok:

| | Console conversation | Console with `bypass_approvals.grok` | Any other run |
|---|---|---|---|
| `session/request_permission` | question card, the agent's options, choices only | unexpected (below) | unexpected (below) |
| The agent's question | question card | question card | task fails with the question as its error |
| Plan approval | card with the plan: approve or reject | approved, plan written as a note | approved, plan written as a note |

- An unexpected permission request in a bypassed session is never granted silently: answer the `allow_once` option and write a note naming the tool call. Never choose `allow_always`. No `allow_once` option: fail the task with the request's title.
- Any other request that expects an answer (an unknown `x.ai/*` method, fs, terminal): reply JSON-RPC error `-32601` and fail the task with the method's name. Never answer an unknown request with a success.
- `x.ai/ask_user_question` and `x.ai/exit_plan_mode` are unverified candidate names from the earlier source reading; the names and shapes actually used are taken from step 1. Handling the agent's question and its plan approval in the Console is required, not optional. If the installed CLI does not send them to an ACP client under these or other names, or sends them in a form that cannot meet the Console question and plan acceptance safely, that is a blocker: record the findings in the design document and in this item, stop, and report for the owner's decision. The rows are not dropped, the scope is not reduced without that decision, and no doc or tool description claims a capability the installed CLI does not have.

Cancel (the task's context ends):
1. Answer pending permission, question and plan requests as cancelled.
2. Send `session/cancel`.
3. Wait a short fixed time for the prompt response.
4. `Sessions.Run` closes the process and kills its group, as today.

The task ends as cancelled whatever the CLI answered.

Usage:
- From what step 1 found (the result's `_meta`, a `usage_update`, or `grok usage`). Assume no schema: a missing, renamed or mistyped field records no usage and never fails the task. Do not derive a task's usage from running totals unless step 1 showed how they reset.
- Rows under host `grok-build`, operation `coder`, model as the CLI names it, else `grok`. Catalog pricing; a model without a price keeps tokens and no cost.

### Step 3: wiring

- `agent/coder_tool.go`: `coderBackendGrok`, the enum, the description, the parameter check; `cmd/mistermorph/tools.go:58` description.
- `internal/codersessions/sessions.go`: accept `grok`; make the `switch` explicit so an unknown backend can never run as agy.
- `internal/coderusage/usage.go`, `recorder.go`: `BackendGrok`, its host. `Host` gets an explicit case.
- Quota (`internal/daemonruntime/server_routes_coder_quota.go`, `agent/coder_tool.go` `reportUsage`): Grok has none. A refresh starts no `grok` process and reports neither a quota nor an error for it; a Grok run's usage line has no quota part. `readCoderQuota` must not reach `ReadCodexQuota` for `grok`. The Console's Coding agents dialog (`web/console-nsh/components/observe/coder-quota.ts`) keeps its three sections.
- `tools.coder.bypass_approvals.grok`, default false: `internal/configdefaults/defaults.go:282`, `internal/configsettings/fields.go:60`, `cmd/mistermorph/consolecmd/runtime_support.go:62`, `agent/engine_tools.go:21` comment, `web/console-nsh/lib/core/config-field-groups.js:164`, `assets/config/config.example.yaml`.
- `internal/channelruntime/taskruntime/coder_progress_notification.go:146`: the name `Grok Build`.
- `internal/shellenv/coder_env.go` `DefaultCoderInstallDirs`: add the installer's directory only if step 1 found one that is not already listed, with the source and date in the comment.
- `internal/codersessions/installed_test.go`: `MISTER_MORPH_CODER_SESSION_TEST=grok`.

### Step 4: docs

In the same change, and only now (until then the docs name three coders):
- `docs/tools.md`, `web/vitepress/docs/guide/built-in-tools.md`, `subagents.md`, `config-reference.md`: the fourth coder, its command, sign-in, approvals, what is and is not kept across a restart, no quota.
- `assets/config/config.example.yaml`: the coder comments and `bypass_approvals.grok`.
- `docs/feat/feat_20261126_coder_grok_build_acp.md`: status, the version built against, the spike's findings, what was not checked.
- New docs in English only.

### Out of scope

- A shared ACP layer; changes to the behaviour of the Claude Code, Codex or Antigravity backends.
- `grok agent serve` and `grok agent headless` (WebSocket), `grok -p`, MCP servers for the session, choosing the model or reasoning effort.
- A subscription quota for Grok.
- Sessions per chat outside the Console, and approvals there.

### Acceptance criteria

Console conversation (the run can ask):
- `coder=grok` runs a task; text, tool steps and `planning` show as progress and notes; the answer is the task's own text.
- A second task in the same conversation reuses the process and the session.
- A permission request is a card with the agent's options; allow lets the action run; reject does not run it, and the task goes on or ends as the CLI decides, never reported as approved.
- The agent's question is a card and its answer reaches the agent. A plan is a card; approve continues, reject does not execute the plan.
- With `tools.coder.bypass_approvals.grok=true` the process starts with `--always-approve`; a changed setting reopens the process before the next task; a question is still a card.
- After the process is closed (failure, cancel, crash, changed setting) the next task reopens the session by the advertised capability, or starts a new one with the note. No later task fails only because the earlier session is gone.

Any other run (`run`, channels, cron, heartbeat, `chat`):
- The process starts with `--always-approve`; a task completes without a card.
- The agent's question fails the task with the question's text as its error, and the process is closed.
- An unexpected permission request is allowed once with a note, or fails the task when it has no `allow_once` option. An unknown request fails the task.
- Several `coder=grok` calls in one run share one session; nothing is left running when the run ends.

Every run:
- Not signed in: the task fails at once with the sign-in message, `NotSignedIn` is set, no browser opens.
- `grok` not on the coder's PATH: the same error the other coders give.
- Cancel: the task is cancelled, never done; the process and what it started are gone (checked on the real CLI in step 1 and by the lifecycle test on Linux).
- Any `stopReason` but `end_turn`, a JSON-RPC error and a dead process are failed results with the reason; none is a success.
- Usage present: one row per model under `grok-build`. Usage absent or malformed: no row, and the task's outcome is unchanged.
- No quota: nothing is read, stored or shown for Grok; a quota refresh with `grok` installed runs no Grok and no Codex reader for it.
- `coder=codex`, `coder=claude` and `coder=agy` behave as before; their tests pass without edits to their expectations.
- The docs name four coders, and say what was not checked.

### Tests

Stand-in CLI in `internal/codersessions` (beside the three in `sessions_test.go`), replaying step 1's lines:
- handshake; `cached_token` and `xai.api_key`; missing sign-in (fixtures hold placeholder ids and no key or token);
- two tasks on one process, each with its own answer, notes and progress;
- text blocks accumulated in order, a non-text block, another session's update, an unknown update kind;
- each `stopReason`, a JSON-RPC error, a process that dies mid-task;
- a permission allowed and rejected in the Console; an unexpected one when bypassed, with and without an `allow_once` option;
- a question and a plan: Console, Console bypassed, and a run that cannot ask;
- an unknown request answered `-32601` and failing the task;
- cancel with a pending request: the cancelled answers, `session/cancel`, the task's error;
- reopen by `session/resume`, by `session/load` with a replay that must not reach the answer, and with neither capability;
- usage present, absent and malformed;
- the command line for a session that asks and for a bypassed one.

Add `grok` to the backend loops of `TestSessionReuseUsageAndScope`, `TestSessionQuestionsFailureAndCancel`, `TestConsolePermissionAndResume` and `TestResetCancelsBusySession` where the stand-in supports the case.

Elsewhere:
- `agent/coder_tool_test.go`: the enum and the check accept `grok`; `agent/coder_usage_test.go`: the usage line without a quota part and the `usage.db` row's host.
- `internal/coderusage`: `Host("grok")`.
- `internal/daemonruntime/server_coder_quota_test.go`: a refresh with `grok` available calls no reader for it.
- `internal/configdefaults`, `internal/configsettings`, `cmd/mistermorph/consolecmd/runtime_support_test.go`: the new key.
- `internal/channelruntime/taskruntime/coder_progress_notification_test.go`: the name.
- `internal/codersessions/lifecycle_linux_test.go`: a Grok stand-in that leaves a command running is cleaned up on cancel.
- Console: `nsh check` and `web/console-nsh/scripts/test.sh` if `config-field-groups.js` or its strings change.

Opt-in, not part of the required run (uses the signed-in account): `MISTER_MORPH_CODER_SESSION_TEST=grok go test ./internal/codersessions -run TestInstalledCoderSession`. Run it once and write the result and the version in the design document.

Required: `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`.

## factory · 2026-11-26 15:19

Moved to `backlog/`: the mandatory real-CLI protocol spike is blocked. The manager and Claude Code independently found no installed `grok` executable on PATH or in customary user-level installation directories. No CLI version, authentication, permissions/questions/plan protocol, cancellation or usage behavior could be verified. The request explicitly forbids implementing from documentation alone when a signed-in CLI is unavailable.

No product code was changed, no installs were made, no commits were made on the code branch, and no tests were run. The owner must make a signed-in Grok CLI available to the builder, then move this item to `new/` to retry. The existing design remains planned and unverified.

## factory · 2026-11-27 11:54

Owner request, quoted verbatim: “ok implement FT190”. Moved to `new/` on that word. What blocked the earlier build is gone: `grok 0.2.114` is installed at `~/.local/bin/grok`, and the owner signed in with `grok login` (`grok models` answers "You are logged in with grok.com"). Step 1, the protocol spike against the real CLI, can run.

## factory · 2026-11-27 11:55

Owner, quoted verbatim: “no move to factory. implement here.” Moved back to `backlog/`: the move to `new/` above was not what the owner asked for. No factory build ran, no branch was pushed. The owner has it implemented outside the factory, in their own checkout.

## factory · 2026-11-27 15:46

Moved to `done/` on the owner's word. Built outside the factory, in the owner's checkout, against the real CLI (grok 1.0.92): commit `5ea07a50`, merged into `master` as `1e5508cf` and pushed. No tag. No factory review ran. Findings and what was not checked are in `docs/feat/feat_20261126_coder_grok_build_acp.md`.
