# Tools Reference

This document describes the built-in and runtime-injected tool parameters currently implemented in the codebase (based on the current tool constructors/registrars and runtime wiring functions).

## Registration and Availability

### 1) Tool classes in current code

- `static` tools (fully constructable from config and Contacts state):
  - `read_file`, `write_file`, `bash`, `powershell`, `url_fetch`, `web_search`, `contacts_send`, `agent_send`.
  - `contacts_send` is static. Awareness runs (heartbeat, cron) see it when enabled; an explicit `$contacts_send` shows it for that task. Ordinary runs (Console, Telegram, Slack and the other channel runtimes) get it as a deferred tool when enabled and `tools.tool_search.enabled` is on: hidden until `tool_search` finds it. Group chats and Bluesky/X public threads still need `$contacts_send`. See [`contacts_send`](#contacts_send).
  - `agent_send` is exposed only while at least one active Contact is `kind: agent`.
  - `contacts_list` lists the contacts (in `agent.db`) whenever a contacts folder is configured.
  - `todo_list` lists the TODO list (the jobs in `agent.db`) whenever the runtime has a state folder. It only reads, so it does not depend on `tools.job_manage.enabled`.
  - `config_get`, `config_set`: the agent's own config, as deferred tools found with `tool_search` (registered only while `tools.tool_search.enabled` is on and the runtime knows its config). Awareness runs (heartbeat, cron) get `config_get` only. See [`config_get` and `config_set`](#config_get-and-config_set).
- `engine-scoped` tools:
  - `spawn`: registered when an agent engine is assembled for a run; depends on the current subtask runner and parent tool lookup. See [`spawn`](#spawn).
  - `list_model_profiles`: registered next to `spawn` when more than one model profile can run a subtask. See [`list_model_profiles`](#list_model_profiles).
  - `coder`: registered when an agent engine is assembled for a run; depends on the current subtask runner and starts the local Codex, Claude Code, Antigravity (`agy`) or Grok Build (`grok`) CLI.
  - `codemode`: registered by the engine when `tools.codemode.enabled` (default on); runs a JavaScript program that calls the run's tools. Never given to subtasks. See [`codemode`](#codemode).
- `runtime-dependent` tools:
  - `job_manage` (formerly `todo_update`): runtime-injected, depends on active LLM client/model plus the state folder and contacts paths from runtime config.
  - `plan_create`: runtime-injected, depends on active LLM client/model.
  - `image_generate`, `image_edit`: per-task runtime tools. They depend on usable image LLM config, `file_cache_dir`, and image intent/retention state.
  - `send_voice`, `send_photo`, `send_file`: runtime-injected, depend on active Telegram API context/chat metadata.
  - `message_react`: runtime-injected in Telegram and Slack runtimes; params/context differ by channel.
  - `memory_save`, `memory_search`, `memory_forget`, `journal_search`, `journal_read`: registered for a top-level run that has an audience when `memories.enabled` (default on). `memory_save` is always visible; the others are deferred and found with `tool_search`. See [Memories](./memories.md#tools).
  - `workspace_list`, `workspace_use`, `topic_search`, `topic_read`: the Console owner's own chat runs only (not TODO runs, Agent Link messages, channel runtimes or subtasks). Deferred, found with `tool_search` when it is on. See [Other topics and workspaces](#other-topics-and-workspaces-console).
  - `work_thread`: the Console owner's runs in Solo only. Always listed there (not deferred). See [`work_thread`](#work_thread-console-solo).
  - `skill_install_preview`, `skill_install`: Console only. A task that names one with `$` (the Skills page's Add skill does) gets it visible and runs with only the install tools. With `tools.tool_search.enabled` (default on), every other Console task gets both as deferred tools, found with `tool_search`. `skill_install` always asks for approval. See [Console skills page](./feat/feat_20260926_console_skills_page.md#41-installing-is-a-task).

### 2) ASCII architecture

```text
Config Source A (CLI/Channels)                    Config Source B (integration)
--------------------------------                  --------------------------------
LoadRuntimeToolsRegisterConfigFromViper()         runtimeSnapshot + feature flags
                 |                                                 |
                 v                                                 v
          RuntimeToolsRegisterConfig <---------------------- build runtime cfg
        { PlanCreateRegisterConfig, TodoUpdateRegisterConfig, ImageToolsRegisterConfig }
                                   |
                                   v
tools.NewRegistry()
   |
   v
RegisterStaticTools(...)
   |
   v
Execution path split:

  A) run / serve / integration run-engine
     RegisterRuntimeTools(reg, runtimeCfg, llmClient, model)
       |-- RegisterImageTools(...)
       |-- RegisterPlanTool(...)
       `-- RegisterTodoUpdateTool(...)
            |
            v
         buildLLMTools(...) -> Engine exposes tool schemas to LLM

  B) telegram / slack / line task runtimes
     clone/copy base registry (base registry required non-nil)
       `-- RegisterRuntimeTools(taskReg, runtimeCfg, llmClient, model)
              |-- RegisterImageTools(...)
              |-- RegisterPlanTool(...)
              `-- RegisterTodoUpdateTool(...)
                    |
                    v
               SetTodoUpdateToolAddContext(...)
               + Telegram runtime tools (telegram_*)
               + Slack runtime tool (`message_react`, when runtime context and emoji catalog are available)
                    |
                    v
               buildLLMTools(...) -> Engine exposes tool schemas to LLM
   |
   v
LLM tool call -> registry.Get(name) -> tool.Execute(...)
```

Flow notes:

- Phase A (static): build base registry via `RegisterStaticTools`.
- Phase A.5 (engine tools): register engine-scoped tools such as `spawn` and `coder` when `agent.New(...)` assembles a runnable engine.
- Phase B (runtime deps): build `RuntimeToolsRegisterConfig`, then inject via `RegisterRuntimeTools`.
- Tool `enabled=false` means the tool is not exposed by default. A task can opt in for one turn with `$name`, for example `$bash` or `$image_generate`.
- `$name` does not execute a tool directly. It only makes the matched tool schema available for the current task.
- If `$name` does not match any skill or tool, it remains ordinary user text. The runtime does not report a missing capability.
- Explicit opt-in does not bypass guard rules, sandbox limits, credentials, runtime prerequisites, or host tool allowlists.
- `coder` follows the same explicit opt-in path: `tools.coder.enabled=true` exposes it by default, and `$coder` exposes it for the current task. Each CLI runs one way in every runtime, as a session over stdio: Codex on `codex app-server`, Claude Code on `claude -p` with JSON streams (`--input-format stream-json --output-format stream-json`), Antigravity on `agy acp`, Grok Build on `grok agent stdio`. A session is one CLI process that takes one task after another; it lasts for a Console conversation or, elsewhere, for one run. Nothing reads a CLI's interactive screen. Only Console tasks can ask approvals and questions; other runs bypass approvals and fail with the question text if the CLI needs an answer. `tools.coder.bypass_approvals.codex`, `.claude`, `.agy` and `.grok` turn approvals off in the Console too (the CLI's own questions are still shown there). All default to false. The supported coders are these four.
- Grok Build's session is `grok --no-auto-update agent --no-leader stdio` (ACP), with `--always-approve` before `stdio` when approvals are bypassed. Built and checked against grok 1.0.92 on Linux; see [`feat/feat_20261126_coder_grok_build_acp.md`](feat/feat_20261126_coder_grok_build_acp.md) for what was seen and what was not checked.
  - Sign-in: `grok login` in a terminal (kept under `~/.grok`, found with `HOME` alone), or `XAI_API_KEY` listed in `tools.bash.injected_env_vars`. Without either, the task fails at once with `grok is not signed in: run grok login in a terminal, then try again`; no browser is opened.
  - In the Console, an approval (`session/request_permission`) is a question card with grok's own options; a rejected approval ends the task as failed, because grok ends the turn. Grok's own question (`ask_user_question`) is a card, one per question. The plan it puts up when it leaves plan mode (`exit_plan_mode`) is a card with the plan: Approve, Reject, or a typed answer that rejects it with what to change. With `bypass_approvals.grok`, and in every run outside the Console, the plan is approved without asking and written down as a note.
  - A request from grok that the runtime does not know (its file, terminal and other `x.ai` extensions) is answered with an error and fails the task; it is never answered as a success. A session started with `--always-approve` that still asks for an approval gets it allowed once, with a note, never for good.
  - Only `end_turn` is a success. A refusal, a token or turn limit, a cancellation, an error and a dead process fail the task and keep the text written so far.
  - A cancelled task tells grok to cancel (`session/cancel`), which stops the commands it started. Grok runs its commands in sessions of their own, where a kill of grok would not reach them, so a session is closed by ending grok's input and giving it 3 seconds to stop them and exit before it is killed.
  - After the process is closed (a failure, a cancel, a crash, a changed `bypass_approvals.grok`), the next task of the conversation reopens the session with `session/resume`. If it cannot be reopened, the task starts a new session and says in a note that the earlier conversation was not carried over.
  - Usage is the prompt's own, per model, from the prompt result, recorded under the host `grok-build`. Grok Build reports no subscription quota outside its interactive screen: none is read, kept or shown, and the Console's Coding agents dialog has no section for it.
- Claude Code's session is `claude -p … --permission-prompt-tool stdio --session-id <uuid>`, with `--permission-mode default` when it asks and `--dangerously-skip-permissions` otherwise. A task is one user message on its stdin and ends with its `result` line. A permission prompt and Claude Code's own question (`AskUserQuestion`) arrive as `control_request` lines and become question cards; a denied action does not end the task. A task that is cancelled or fails, a process that died and a changed `bypass_approvals.claude` close the process, and the next task of the conversation reopens the session with `--resume <uuid>`. See [`feat/feat_20261116_coder_sessions_everywhere.md`](feat/feat_20261116_coder_sessions_everywhere.md).
- `coder` starts the CLIs in the bash tool's environment, not in the runtime's own. One code path (`internal/shellenv`) builds both, for each run, so what a coder run gets is what a bash command gets at that moment: the allowlisted variables (`HOME`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TERM`, `TZ`, `TMPDIR`, `USER`, `LOGNAME`, `SHELL`, the `XDG_*` directories, `SSL_CERT_FILE`, `SSL_CERT_DIR`), the variables of `tools.bash.injected_env_vars` (including the ones a task adds to its bash tool), and the bash tool's `PATH`. Nothing else of the runtime's environment reaches the CLI or the commands it runs. This holds for every coder session, in every runtime, and for the quota reads (`codex app-server`, `claude -p /usage`, `agy -p /usage`, the `/stats/coder/quota` routes). Grok Build has no quota read.
  - What no longer passes unless it is listed in `tools.bash.injected_env_vars`: proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`, `ALL_PROXY` and their lowercase forms), `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `GROK_HOME`, provider keys and endpoints used for API billing (`OPENAI_API_KEY`, `XAI_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` / `CLAUDE_CODE_USE_VERTEX` with the cloud credentials), `NODE_EXTRA_CA_CERTS`, and every other variable of the service. A setup that relied on one of them stops working until it is listed. A subscription sign-in kept under the home directory (`~/.codex`, `~/.claude`, `~/.grok`) needs nothing: `HOME` is in the allowlist. The Antigravity CLI's sign-in was found with `HOME` and `PATH` alone on Linux (agy 1.5.9); macOS and Windows were not checked. Codex's usage reader looks for a session's rollout files where the CLI's own environment puts them: under `CODEX_HOME` when injected, else `~/.codex`.
  - `PATH`, in order: `tools.coder.path_extra`; `tools.bash.path_extra`; the runtime's `PATH` (the bash tool's fallback `/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin` when it is empty); and, only while `tools.coder.path_extra` is empty, the CLIs' default install locations. Of those only directories that exist are added, none twice, and always last, so they never replace a CLI the `PATH` already finds: `~/.local/bin` (the Codex, Claude Code and Antigravity installers on macOS and Linux), `/opt/homebrew/bin`, `/usr/local/bin`, `/home/linuxbrew/.linuxbrew/bin` (Homebrew); on Windows `%USERPROFILE%\.local\bin` (Claude Code) , `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin` (Codex) and `%LOCALAPPDATA%\agy\bin` (the Antigravity CLI). An npm global install under a version manager has no fixed path: add its directory to `tools.coder.path_extra`. A CLI found nowhere in that `PATH` fails the run.
  - On Windows the coder gets the PowerShell tool's environment instead (the allowlist above plus `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `SystemRoot`, `PATHEXT`, `TEMP` and the rest of that tool's list), the variables of `tools.powershell.injected_env_vars`, and the same `PATH` order.
- `coder` reports what each run used and how much of the coder's subscription quota is left. The CLI's own stream gives the run's tokens (Codex rollout responses with actual model names, the Antigravity ACP prompt result) or tokens and list-price cost per model (Claude Code's `result` line); these go into `usage.db` under the hosts `codex-cli`, `claude-code` and `antigravity-cli` (under the model agy says it runs, e.g. `gemini-3.8-flash-high`; `agy` when it names none), operation `coder`. Grok Build's prompt result gives its tokens per model (e.g. `grok-4.7-build`), recorded under the host `grok-build`; it has no quota, so its usage line has no quota part. Every coder row is priced from the pricing catalog; Claude Code's own cost stands only for a model the catalog has no price for, and an agy model without a price keeps its tokens and no cost. The usage line's cost is that row cost. Claude Code reports its 5-hour and 7-day windows during a task (`rate_limit_event`); Codex's are read after each task from that session's `codex app-server` (`account/rateLimits/read`, which uses no quota); the Antigravity CLI's, which are per model group (e.g. `Gemini Models`, `Claude and GPT models`) and given as what remains, after each agy run from `agy -p /usage --output-format json`, which the CLI answers itself. The last quota of each coder is kept in `usage.db` (`coder_quota`). The tool result's `usage` field and the run's last activity line say both, e.g. `claude run: 48.2k in (31.0k cached) · 3.1k out · $0.21 at list price · 6 turns; claude quota: 5h 92% used (resets in 2h10m), 7d 30% used`. A Claude Code task's usage is its `result` line's `model_usage_since_last_result` (the line's `modelUsage` and `total_cost_usd` are running totals of the process and are never used for a task: a `result` line without `model_usage_since_last_result` records no usage); its rows carry the CLI's list price, marked estimated. A task that is cancelled or whose process dies has no `result` line and records no usage. Codex retains actual-model catalog pricing from individual rollout responses, including sub-agents; protocol usage is a fallback when rollouts are unavailable. Rows that earlier builds wrote for Claude Code's terminal sessions keep their requests (`llm_requests.pricing_parts`) and are still priced again when the catalog changes. The Console's Usage page has a Coding agents button in its bar that opens the quotas in a dialog (`GET /stats/coder/quota`); opening it reads every installed coder's at once (`POST /stats/coder/quota/refresh`): Codex's from its app server, Claude Code's from `claude -p /usage --no-session-persistence` and the Antigravity CLI's from `agy -p /usage --output-format json`, local commands that call no model. None uses quota. For agy the usage line names each group's windows, e.g. `agy quota: Gemini Models 7d 93% used (nearly used up) (resets in 2d), Claude and GPT models 7d 100% used (limit reached) (resets in 2d); limit reached for Claude and GPT models`. See [`feat/feat_20261116_coder_sessions_everywhere.md`](feat/feat_20261116_coder_sessions_everywhere.md) for the `agy acp` session and [`feat/feat_20261115_coder_agy.md`](feat/feat_20261115_coder_agy.md) for the quota read (that document's one-shot `stream-json` run was replaced by the session).
- `$image_generate` / `$image_edit` and natural-language image intent use the same per-task tool trigger path.
- Image tools are checked per task, not once at process startup.
- Image tools are registered only when image config is usable. Full inheritance from top-level `llm.*` is allowed only for top-level `openai` or `gemini` with `llm.api_key`; `openai_codex` and `xai_oauth` do not provide image-tool credentials. Both OAuth providers may still accept image input in chat.
- Phase C (task shaping):
  - `run`/`serve`/integration run-engine: inject runtime tools directly into execution registry.
  - `telegram`/`slack`/`line`: copy base registry per task, re-register runtime tools on task registry, then bind task context with `SetTodoUpdateToolAddContext`.
  - Telegram-only task registry adds `send_voice`, `send_photo`, `send_file`, `message_react`.
  - Slack task registry may add `message_react` when runtime context allows.
- Image-tool retention:
  - console web topics and CLI chat sessions keep image tools after the first image-intent task.
  - Telegram, Slack, Lark, and LINE conversations keep image tools for 16 subsequent turns; another image-intent task refreshes the counter.
- First-principles invariants:
  - correctness: task toolset matches chat/channel context.
  - isolation: `job_manage` context is task-scoped.
  - determinism: no hidden fallback registration path.
  - minimality: Phase C shapes task registry only.

### 3) From registry to execution

- `buildLLMTools` converts registry entries to `[]llm.Tool` using each tool's `Name()`, `Description()`, `ParameterSchema()`.
- Engine sends this set on each LLM call.
- On tool call, engine resolves by `registry.Get(name)` and runs `tool.Execute(ctx, params)`.

### 4) `mistermorph tools` command view

- `tools` command prints:
  - `Core tools`: from base registry.
  - `Extra tools`: preview of engine-scoped and runtime-dependent tools (currently `spawn`, `coder`, `plan_create`, `job_manage`, and image tools when task intent allows them). `list_model_profiles` depends on the configured profiles and is not previewed.
  - `Telegram tools`: static preview rows for Telegram runtime tools.

## `read_file`

Purpose: read local text file content (very long output may be truncated).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | None | File path. Supports `file_cache_dir/<path>` and `file_state_dir/<path>` aliases. |

Constraints:

- Access can be blocked by `tools.read_file.deny_paths`, which also matches a symlink's target. `agent.db`, `jobs.db`, `config.yaml.imported` and the SQLite `-wal`, `-shm` and `-journal` files of those and of every listed entry are always denied, whatever the list says, so a list written by an older config template still protects them. `send_file`, `bash` and `powershell` apply the same rule to their lists.
- Alias paths must include a relative file path; passing only `file_cache_dir` or `file_state_dir` is invalid.

## `write_file`

Purpose: write local files (overwrite or append).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | None | Target path. Relative paths are written under `file_cache_dir` by default. Supports `file_state_dir/<path>`. |
| `content` | `string` | Yes | None | Text content to write. |
| `mode` | `string` | No | `overwrite` | `overwrite` or `append`. |

Constraints:

- Parent directories are created automatically when needed.
- Writes are allowed only under `file_cache_dir` / `file_state_dir`.
- Content size is limited by `tools.write_file.max_bytes`.

## `bash`

Purpose: execute local `bash` commands.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `cmd` | `string` | Yes | None | Bash command to execute. Supports `file_cache_dir/...` and `file_state_dir/...` aliases. |
| `cwd` | `string` | No | Current directory | Working directory for command execution. Supports `file_cache_dir/...` and `file_state_dir/...` aliases. |
| `timeout_seconds` | `number` | No | `tools.bash.timeout` | Timeout override in seconds. |
| `run_in_subtask` | `boolean` | No | `false` | If `true`, run the command inside the direct bash subtask boundary and return the structured subtask envelope JSON. In a subtask at the depth limit (depth 2), the command runs in the current subtask instead. |
| `elevated` | `boolean` | No | `false` | Linux and macOS: run the command as root after the user approves it in a system dialog (see [Elevated commands](#elevated-commands)). Offered only when elevation is available. |
| `keep_running` | `boolean` | No | `false` | Linux and macOS: leave what the command starts running after the task ends (a dev server, a tunnel, a watcher, or an app or browser it opens: `xdg-open` starts the browser as the command's child when it is not running yet). Without it, those processes are stopped when the task ends (see [Leftover processes](#leftover-processes)). |

Constraints:

- Default enablement is platform-specific: enabled by default on Linux/macOS, disabled by default on Windows. Override with `tools.bash.enabled`.
- Restricted by `tools.bash.deny_paths` and internal deny-token rules.
- Runs with an allowlisted environment instead of inheriting the full parent process environment.
- Extra environment variables can be injected via `tools.bash.injected_env_vars`. Each entry may be:
  - a variable name string: resolved from the parent process when config is loaded, then injected as a fixed `name=value` pair;
  - an object `{name, value}`: injects the literal value (its YAML scalar `value` supports `${ENV_VAR}` and `${aws-sm:<secret-id>}` expansion when the config file is loaded via `ReadExpandedConfig`).
- `tools.bash.rewrite.enabled` optionally prefixes commands before execution with `tools.bash.rewrite.binary`. For example, binary `rtk` turns `git status` into `rtk git status`.

## `powershell`

Purpose: execute local PowerShell commands.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `cmd` | `string` | Yes | None | PowerShell command to execute. Supports `file_cache_dir/...`, `file_state_dir/...`, and backslash variants such as `file_cache_dir\...`. |
| `cwd` | `string` | No | Current directory | Working directory for command execution. Supports `file_cache_dir/...` and `file_state_dir/...` aliases. |
| `timeout_seconds` | `number` | No | `tools.powershell.timeout` | Timeout override in seconds. |
| `elevated` | `boolean` | No | `false` | Windows: run the command as administrator after the user approves the UAC prompt (see [Elevated commands](#elevated-commands)). Its output arrives when it ends. |
| `keep_running` | `boolean` | No | `false` | Linux and macOS (`pwsh`): as for `bash`. Not offered on Windows. |

Constraints:

- Default enablement is platform-specific: enabled by default on Windows, disabled by default on Linux/macOS. Override with `tools.powershell.enabled`.
- Restricted by `tools.powershell.deny_paths` and internal deny-token rules.
- Runs with an allowlisted environment instead of inheriting the full parent process environment.
- Extra environment variables can be injected via `tools.powershell.injected_env_vars`, using the same string or `{name, value}` object forms as `tools.bash.injected_env_vars`.
- Unlike `bash`, it does not currently support `run_in_subtask`.

### Leftover processes

A command can start programs that outlive it: `loop.sh &`, `nohup server &`, a daemon. When the
command exits they are re-parented (to init, or a subreaper), so their parent no longer says where
they came from. On Linux and macOS each task marks what it starts and stops what is left when it
ends (`internal/proctrack`):

- `bash` and `powershell` run each command in its own session with `MISTERMORPH_RUN_ID` (the task)
  and `MISTERMORPH_TOOL_CALL` in its environment. Every descendant inherits both, also one that
  starts a session of its own; one that clears its environment still keeps the session id.
- A coding CLI's server (`coder`) outlives the task that starts it, since the next task reuses it.
  It runs with its own `MISTERMORPH_CODER_SESSION` tag. What it starts and leaves behind during a
  task (no longer under the live server) is the task's; what stays under the server (its MCP
  servers, its own terminals) is the server's.
- When the task ends, not when it pauses for an approval, the processes it left are sent `SIGTERM`,
  then `SIGKILL` after 2 seconds. This holds for every task: a Console or chat reply, an awareness
  (cron) run, `mistermorph run`. A command run with `keep_running: true` is left alone.
- Only the user's own processes are seen: one run with `sudo` (`elevated`) can be neither found
  nor stopped.
- The Console shows a reply's processes under **Processes**, beside Progress: what runs now, as a
  tree under the call that started it ("left behind" when it was re-parented), and what was
  stopped. Each process has a Stop, which ends it and what it started. The API is
  `GET /tasks/{id}/processes` and `POST /tasks/{id}/processes/kill` (`{"pid": n}`); a runtime only
  knows the tasks it ran since it started.
- Windows: not tracked yet.

### Elevated commands

Commands run without a terminal, so `sudo` cannot ask for a password in them. Instead the model
sets `elevated: true` (on `bash` on Linux and macOS, on `powershell` on Windows), and the user
approves the command, which is shown to them:

- **In the chat that started the task** (Linux, macOS): a task sent from the web Console's chat or
  from `mistermorph chat` shows an approval card with the command and a password field. The
  password goes to the runtime over the client's connection, which is all that protects it: use
  HTTPS, an SSH tunnel or a VPN such as WireGuard. While the page or the Console's link to the
  runtime is plain HTTP to another machine, the web Console shows a warning across the top (the
  runtime cannot tell: a TLS proxy or a VPN looks like plain HTTP to it). Chat attached with `--runtime-url` already requires HTTPS for a runtime
  on another machine. Local chat runs the agent in its own process and asks directly.
- **Otherwise, in a system dialog on the agent's machine:**

| OS | Runs as | Dialog |
|---|---|---|
| Linux | `sudo -k -A -- bash -c <cmd>` | the system's `pinentry` (unless it is a terminal variant), else `pinentry-gnome3`, `pinentry-qt`, `pinentry-gtk-2`, `zenity` or `kdialog` |
| macOS | `sudo -k -A -- bash -c <cmd>` | the native AppleScript dialog, password hidden |
| Windows | `Start-Process powershell -Verb RunAs` | the UAC prompt |

- On Linux and macOS, mistermorph is sudo's askpass helper: sudo starts the binary in askpass mode,
  which gets what the user typed in the dialog from the agent process and hands it to sudo. The
  agent process holds the password in memory only to pass it on; the model, the tool output and
  the logs never see it. `tools.bash.elevation.askpass` names another
  askpass program to use instead, such as an embedding program's own (see
  [Your own askpass program](integration.md#your-own-askpass-program)).
- Every elevated command needs its own approval: `-k` makes sudo ignore cached credentials, and each
  command runs in a new session.
- Declined or unanswered, the command does not run and the tool says so.
- Offered when the tool's `elevation.enabled` is true (`tools.bash.elevation.enabled`,
  `tools.powershell.elevation.enabled`; the default; off for embedded programs, which also
  call `integration.RunAskpassIfRequested()` at the start of `main`, see `docs/integration.md`) and
  someone can be asked. In the Console and in chat that needs only `sudo`. For the dialog, on Linux
  `sudo`, a desktop session (`DISPLAY` or `WAYLAND_DISPLAY`) and one of the dialog programs; on
  macOS `sudo` and `osascript`. With an askpass program set, only `sudo` and that program.
- `tools.bash.elevation.approver` picks where to ask: `auto` (the chat that started the task, else
  the dialog; the default), `client` (only there) or `dialog` (only the dialog).
- A non-elevated command whose `sudo` fails for want of a terminal gets a note suggesting
  `elevated: true`.
- Settings, under `tools.bash.elevation` and `tools.powershell.elevation`: `enabled`,
  `approval_timeout` (how long the dialog waits, on top of the command's timeout; default `2m`), and
  for bash `dialog` (a dialog program instead of the automatic choice), `askpass` (an askpass
  program instead of mistermorph's helper) and `approver`.
- Design: `docs/feat/feat_20261024_elevated_commands.md`, and for approval in the chat,
  `docs/feat/feat_20261026_elevation_client_approval.md`.

## `url_fetch`

Purpose: make HTTP(S) requests and return responses (or download to file).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `url` | `string` | Yes | None | Request URL. Only `http/https` are supported. |
| `method` | `string` | No | `GET` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE`. |
| `auth_profile` | `string` | No | None | Auth profile ID (available when secrets are enabled). |
| `headers` | `object<string,string>` | No | None | Custom headers (allowlist/denylist applies). |
| `body` | `string|object|array|number|boolean|null` | No | None | Request body (for `POST/PUT/PATCH` only). |
| `download_path` | `string` | No | None | Save response body to a cache-directory path. |
| `timeout_seconds` | `number` | No | `tools.url_fetch.timeout` | Timeout override in seconds. |
| `max_bytes` | `integer` | No | `tools.url_fetch.max_bytes` or download cap | Maximum bytes to read. |

Constraints:

- Parent directories for `download_path` are created automatically.
- With `download_path`, the tool returns download metadata instead of embedding large response bodies.
- `headers` has security restrictions (for example, direct `Authorization` and `Cookie` are blocked).
- If `headers` is not provided and `body` is provided, `Content-Type` is inferred from body type (`application/json` for JSON/object bodies, `text/plain` for plain strings).
- At debug log level, the tool logs sanitized outbound request fields (`url`, `method`, `headers`).
- Requests are subject to guard network policy.
- In the desktop app with an explicit network proxy running (the backend has `MISTER_MORPH_DESKTOP_PROXY_REQUIRED=1`), a request or redirect hop to a destination that is not loopback goes through that proxy or is refused; `url_fetch` never connects to it directly. It is refused when `guard.network.url_fetch.allow_proxy` is false, when the auth profile's `allow_proxy` is false, and, for a host name, when `guard.network.url_fetch.deny_private_ips` is true (the proxy would resolve the name, so its address cannot be checked). Under the default guard settings that is every host name. An allowed request that cannot get through fails with an error naming the proxy by type, host and port. See [security.md](security.md).
- Plain `GET` requests for allowlisted public post, shared-chat, article, and video URLs try Defuddle, then Jina Reader, then direct access. The allowlist covers X/Twitter posts and `t.co` short links, Reddit posts, public ChatGPT/Claude/Gemini/Grok shares, LinkedIn/Threads posts, YouTube/Bilibili videos, and Medium/Substack articles. Requests with custom headers, authentication, a body, or `download_path` remain direct.

## `web_search`

Purpose: run web search and return structured results (current implementation uses DuckDuckGo HTML).

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `q` | `string` | Yes | None | Search keywords. |
| `max_results` | `integer` | No | `tools.web_search.max_results` | Maximum returned results (hard-capped at 20 in code). |

## `job_manage`

Purpose: manage jobs, the scheduled tasks of the TODO list kept in `file_state_dir/agent.db`: add them, read one, edit one in place, or delete one.

The tool was called `todo_update`. The earlier name still works: a call named `todo_update` (from an older prompt, a skill or conversation history) runs `job_manage`, `todo_update` in `BuiltinToolNames` or in a task's `$todo_update` reference selects it, and while `tools.job_manage.enabled` is not set, `tools.todo_update.enabled` switches it.

Every job has a stable `id`. New jobs get a generated `job-<uuid>` ID (a random, version 4 UUID in lower case), the same form the Console gives new TODO items; the ID names the job only and says nothing about what starts its runs. IDs from earlier versions (such as `cron-<uuid>`, the Console's `task-<n>`, or one chosen in `cron.yaml`) stay valid and are never rewritten. A job's topic (`_cron_<job id>`) and each of its runs have IDs of their own; see [TODO and Heartbeat](../web/vitepress/docs/guide/todo-and-heartbeat.md).

A job's `content`, like any task text, may reference another job as `[label](job:<id>)`: the run then gets that job's definition and latest finished output as read-only context. `job_manage` stores such a reference as written and does not resolve it. The jobs a job lists in its `uses` are given to its runs the same way, without a link in the text; unlike a reference, a use also starts the job each time the used job finishes. See [Job references](../web/vitepress/docs/guide/todo-and-heartbeat.md#job-references) for what is given, the fallbacks, and who may reference a job.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `action` | `string` | Yes | None | `add_once`, `add_recurring`, `get`, `update`, or `delete`. |
| `id` | `string` | Yes for `get` and `update`; preferred for `delete`; not used on add | Generated for add | Stable job ID. An add always generates the ID (`job-<uuid>`); an `id` passed to an add is not used, and the result carries an `id_generated` warning. |
| `title` | `string` | No | Default task title | Short task title. For `update`, `""` resets it to the default title. |
| `content` | `string` | Yes for add actions; required for delete without `id` | None | Task content, or semantic delete query when `id` is omitted. For `update`, the new content, stored exactly as given (surrounding whitespace trimmed; `people` references are not resolved). |
| `at` | `string` | Yes for `add_once` | None | One-time schedule in `YYYY-MM-DD HH:mm`. For `update`, setting `at` alone makes the task one-time and clears its `cron`. |
| `cron` | `string` | Yes for `add_recurring` | None | Five-field numeric cron expression. For `update`, setting `cron` alone makes the task recurring and clears its `at`. |
| `tz` | `string` | No | Runtime local timezone | IANA timezone or UTC offset, for example `Asia/Tokyo` or `UTC+8`. For `update`, `""` clears it. |
| `people` | `array<string>` | No | None | Mentioned people to resolve into explicit reference IDs in added content. Add actions only: `update` rejects a nonempty list. |
| `chat_id` | `string` | No | Empty (`console:user` in the Console runtime on add) | Task-context chat ID, for example `tg:-1001234567890`. For `update`, `""` clears it; there is no default. |
| `workspace_dir` | `string` | No | Runtime default workspace | Workspace directory for the task's runs: an absolute path or `~/...`, or the literal `workspace_dir` for the workspace attached to the current conversation. The directory must exist when the task is added or updated. For `update`, `""` clears it back to the runtime default. |
| `bash_env` | `array<object>` | No | None | Environment variables injected into `bash` when the task runs, in the task's stored form: `[{"name": "REPORT_MODE", "value": "weekly"}]`. Names are letters, digits and underscores, not starting with a digit; values may reference environment variables as `${NAME}`, which is preferred over literal secrets. For `update`, the list replaces the whole `bash_env`, `[]` clears it, and omitting `bash_env` keeps it unchanged. |
| `add_triggers` | `array<object>` | No | None | Triggers to add to the job, beside the ones it has (`update` and the add actions): `{"kind": "schedule", "cron": "0 9 * * *", "tz": "UTC"}` (or `at`), `{"kind": "poke"}` (at most one per job), or `{"kind": "message", "channel": "telegram", "chat_id": "tg:-1001234567890"}`. Each new trigger gets an `id`, which the result shows. A job has at most 16 triggers. |
| `remove_triggers` | `array<string>` | No | None | `update` only: the `id`s of triggers to remove (`get` lists them). An unknown `id` is an error. The job's `at`, `cron` and `tz` are always those of its first schedule trigger. |
| `uses` | `array<object>` | No | None | The jobs this job uses, at most 8: `[{"job_id": "job-..."}]`. Every finished run of a used job starts this job, which is given that run's output. A use has no other field (`mode` and `max_age` are refused); to only read a job, link to it in `content` as `[label](job:<id>)`. For `update`, the list replaces the whole `uses`, `[]` clears it, and omitting it keeps it. |
| `join` | `string` | No | `all` | How several uses combine: `all` (the default: once all have finished in the same chain) or `any`. For `update`, `""` resets it to `all`. |

`get` returns the job with this `id`, with an explicit `enabled` boolean, its `triggers` (each with its `id`), its `uses` and its `join`. An unknown `id` is an error.

`update` edits a task in place by `id` and changes only the parameters passed: every omitted field (including `bash_env`, `workspace_dir`, schedule, `tz`, `chat_id` and `title`) and the task's run metadata keep their values, and the `id` stays the same. Edit tasks with `update`, not by deleting and re-adding them. Pass at least one field to change; `null` is rejected for every field rather than read as "keep" or "clear" (omit a field to keep it, pass `""` or `[]` to clear it). Parameters `update` does not use are ignored.

Returns:

All actions return JSON with:

- `ok`: whether the operation succeeded (boolean).
- `action`: executed action.
- `task_count`: number of tasks after the operation.
- `task`: the added, read or updated job (add actions, `get` and `update`), with an explicit `enabled` boolean.
- `deleted`: the deleted task (`delete`).
- `fields`: the fields `update` changed, for example `["content", "bash_env"]` (`update` only).
- `warnings`: optional warnings (add actions): reference resolution, and `id_generated` when an `id` was passed.

A task in a result never includes `bash_env` values: `bash_env` is left out and `bash_env_names` lists the variable names, for example `"bash_env_names": ["API_TOKEN"]`. Errors name a bad entry by its index, never its value. In tool events, `tool_call_params` logs and the `chat` command's tool activity line and transcript, `job_manage` arguments (also when called as `todo_update`) show each `bash_env` name with its value as `"[redacted]"`; a [`codemode`](#codemode) script that calls `job_manage` is shown by its size only.

Constraints:

- Controlled by `tools.job_manage.enabled`; while that is not set, by the earlier `tools.todo_update.enabled` (default `true`).
- The jobs are shared with the scheduler, the Console and `todo_list` through `agent.db`'s `jobs` table, in this process or another: each change is one transaction, and every read sees what the others committed.
- Add actions require an LLM client and model when `people` resolution is needed.
- Add actions validate markdown reference IDs before writing.
- `get`, `update` and delete by `id` do not require an LLM.
- A one-time job whose scheduled run fails is tried again after 1, 5, 15 and 60 minutes and then left as it is; `update` with a new `at` starts it afresh.
- Triggers, `uses` and `join` are checked as `PUT /todo/tasks` checks them, with the same error texts: an unknown trigger `kind`, a schedule trigger without exactly one of `at` and `cron`, a second poke trigger, a message trigger without `channel` or `chat_id`, an unknown used job, a job that uses itself, a loop (named), a job used twice, an unknown `join`. A job that other jobs use cannot be deleted.
- `update` runs in one transaction: an unknown `id`, an invalid field, or a resulting task that does not validate (for example a bad schedule or `bash_env` name) returns an error and leaves the stored task unchanged.
- Delete without `id` uses LLM semantic matching on `content`; no match and ambiguous match both return errors.

Errors (string matching):

| Error substring | Trigger |
|---|---|
| `job_manage tool is disabled` | Tool is disabled. |
| `action is required` | Missing `action`. |
| `content is required` | Missing or empty `content` for an add action. |
| `invalid action:` | `action` is not `add_once/add_recurring/get/update/delete`. |
| `job_manage unavailable (missing llm client)` | LLM client not injected. |
| `job_manage unavailable (missing llm model)` | LLM model not configured. |
| `no TODO task with that id` | `get` or `update` named an `id` the list does not have. |
| `was not imported into agent.db` | The one-time import of `cron.yaml` failed; the error names every rejected record (see [TODO and Heartbeat](../web/vitepress/docs/guide/todo-and-heartbeat.md)). |
| `invalid reference id:` | Invalid `(...)` reference exists in text. |
| `missing_reference_id` | Mentioned person cannot be uniquely resolved to a reference ID. |
| `people must be an array of strings` | `people` is not a string array. |
| `people is not used by update` | `update` received a nonempty `people`. |
| `workspace_dir:` | `workspace_dir` does not exist, is not a directory, or names the current workspace when none is attached. |
| `update needs the id of the task to change` | `update` without `id`. |
| `update needs at least one field to change` | `update` with no field to change. |
| `no TODO task with that id` | `update` named an unknown `id`. |
| `must be a string` / `must be an array` | A field has the wrong type or is `null`. |
| `bash_env must be an array of` | `bash_env` is not a list of `{name, value}` objects. |
| `bash_env[` | A `bash_env` entry has a missing or invalid name or value. |
| `invalid reference_resolve response` | Reference insertion LLM returned invalid JSON. |
| `no matching TODO task` | Delete found no matching task. |
| `ambiguous cron task match` | Delete without `id` matched multiple candidates. |
| `invalid semantic_match response` | Delete semantic match LLM returned invalid JSON/schema. |

## Memory and journal tools

Purpose: keep facts across conversations, and check what was actually said. Each tool is bound to the run's audience: it reads and writes only what that audience may hear, and anything else reads as not found. See [Memories](./memories.md).

`memory_save`:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `subject` | `string` | No | The person or group of the run | `owner`, `general`, `contact:<contact id>`, or `conversation:<key>`. |
| `name` | `string` | Yes | None | Kebab-case slug, unique per subject; reusing it replaces that memory. |
| `type` | `string` | Yes | None | `person`, `feedback`, `context`, or `reference`. |
| `description` | `string` | Yes | None | One line, at most 200 characters. |
| `body` | `string` | Yes | None | The fact, at most 4 KiB. Feedback and context end with `Why:` and `How to apply:` lines. |
| `visibility` | `string` | No | Where it was learned | `private`, `conversation`, or `public`; narrowed to the widest the audience allows, and the result says so. |
| `source_events` | `array<string>` | No | None | Journal event IDs the memory comes from. |

Returns `status` (`created` or `replaced`), `id`, `subject`, `name`, `visibility` and `notes`. A save the rules refuse returns an error that says why.

`memory_search`: `query`, `subject`, `type`, `limit` (1–50, default 10). Returns `memories` and `has_more`.

`memory_forget`: `id`. Deletes a memory learned in the run's audience; the owner may delete any.

`journal_search`: `query`, `since` and `until` (RFC 3339 or `YYYY-MM-DD`), `domain`, `limit` (1–100, default 20). Returns `events` (`seq`, `id`, `time`, `domain`, `type`, `task_id`, `text` excerpt) and `has_more`. The owner searches every event; anyone else only their own conversation's.

`journal_read`: `seq`. Returns the event with its payload, cut at 8 KiB (`truncated`).

## Other topics and workspaces (Console)

Purpose: let the owner's Console chat reach past its own topic: other workspaces and other topics. Only the Console owner's own chat runs get these tools; each call is refused from any other run, audience or subtask. See [Console](./console.md#other-topics-and-workspaces).

`workspace_list`: `limit` (1–50, default 20). Returns `workspaces` (`path`, `display` with `~`, `exists`, `last_used`, `kinds` from `attached`/`default`/`recent`, the attached `topics` with `id` and `title` (at most 10, `topics_more`), `current` for the one the task uses now, `topic_workspace` for the topic's own) and `has_more`. Read-only.

`workspace_use`:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | None | A workspace from `workspace_list` or a folder inside one, or a folder the user named in this message (absolute or `~/`). A relative path is taken from the workspace in use. |

Switches the running task's workspace for the rest of the task; the topic's attachment does not change. Returns `workspace_dir`, `display`, `activity` (`Using ~/proj/api`), `topic_workspace`, `is_topic_own` and a `note`. A missing, unreadable, unknown or denied folder (`tools.read_file.deny_paths`, protected state files, the state folder, also through symlinks) fails and leaves the workspace as it was. The first `write_file`, `bash`, `powershell`, `coder`, `spawn`, `image_generate` or `image_edit` call in a workspace other than the topic's asks for approval, once per workspace in the task; reads do not. A write or command after `workspace_use` in the same step, checked before the switch, is not run and says why; the model calls it again and the user is asked. Codemode scripts cannot call it.

`topic_search`: `query` (every word must appear in the title, tags, the user's messages or the replies; omit to list), `tag`, `limit` (1–30, default 10). Returns `topics` (`id`, `title`, `kind` (`topic`, `todo`, `agent_link` or `awareness`), `tags`, `last_activity`, `workspace`, `workspace_source`, `matched_in`, `excerpt`, `excerpt_task_id`), most recently active first, and `has_more`; `partial` when it stopped after reading 20,000 messages.

`topic_read`: `topic_id` (required), `cursor` (`next_cursor` from the previous page), `limit` (1–20, default 5). Returns `topic` (`id`, `title`, `kind`, `tags`, `last_activity`, `workspace`, `workspace_source`), `turns` newest first (`task_id`, `time`, `status`, `message` up to 2,000 characters, `reply` up to 4,000, `error`, attachment names in `files`, referenced file names in `referenced_files`, `*_truncated` flags) and `next_cursor` while older turns remain.

Both topic tools' results reach the model as untrusted tool output, like `read_file`'s.

## `work_thread` (Console Solo)

Purpose: from Solo, the owner's one conversation, start work in a topic and workspace of its own (a work thread) that runs in the background while Solo answers the next message. Only the owner's runs in Solo get it; each call is refused from any other run, audience or subtask. See [Console](./console.md#solo).

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `task` | `string` | Yes | None | What the thread should do, complete: the thread does not see Solo's conversation. |
| `workspace` | `string` | Yes | None | The thread's workspace: a workspace from `workspace_list` or a folder inside one, or a folder the user named in this message (absolute or `~/`). |
| `title` | `string` | For a new thread | None | The thread's title (at most 80 characters). |
| `topic_id` | `string` | No | None | An existing topic to give more work, in its own workspace. Solo, Awareness, TODO and Agent Link topics are refused. |

Creates the topic (marked `started_from: "_solo"`) with the workspace attached, or continues `topic_id`, records the thread's card in Solo and submits the task to the Console's queue; returns at once with `topic_id`, `task_id`, `title`, `workspace`, `state` (`running`), `continued` and a `note`. A missing, unknown or denied folder fails and starts nothing: the model asks the user which workspace. A topic still running a task is refused. The thread works in its workspace as its own: no approval is asked for the workspace itself, whether or not it is Solo's. Guard approvals, a coding agent's own permissions and a later `workspace_use` in the thread ask as in any topic. When the thread's task ends, Solo gets its summary. Codemode scripts cannot call it.

## `todo_list`

Purpose: list the scheduled TODO tasks, the jobs `job_manage` maintains: one-time and recurring, enabled and disabled.

Parameters: none. The tool always reads the runtime's own TODO list (the `jobs` table of `<file_state_dir>/agent.db`); a caller cannot name another path, and other parameters are ignored.

Returns JSON:

- `count`: number of tasks.
- `tasks`: every task in list order, `[]` when there are none. Each task has:
  - `id`, `title`, `content`.
  - `enabled`: always present. `false` for a task that is turned off, `true` otherwise (a task stored without `enabled` is on).
  - `at` (one-time, `YYYY-MM-DD HH:mm`) or `cron` (recurring), and `tz` when set.
  - `chat_id`, `workspace_dir`, `last_run_at`, `last_run_status` when set.
  - `bash_env_names`: the names of the task's `bash_env` variables. Values are never returned.

Example:

```json
{"count":2,"tasks":[
  {"id":"daily-report","title":"Daily report","enabled":true,"cron":"0 9 * * *","tz":"Asia/Tokyo","content":"Write the daily report"},
  {"id":"renew-domain","title":"Renew domain","enabled":false,"at":"2027-03-04 08:30","content":"Renew the domain"}
]}
```

Notes:

- Read-only: it never adds, changes, enables, disables or runs a task, and does not compute next run times.
- Registered whenever the runtime has a state folder, with or without `job_manage`. With `BuiltinToolNames` set, it must be named there.
- A list that cannot be read (for example a damaged `agent.db`, or a `cron.yaml` whose import failed) is an error, never an empty result.

## `config_get` and `config_set`

The agent's own config, where `morph config` keeps it: `agent.db` in the state folder, or the file `--config` names. Both are deferred: they are not in a request until `tool_search` finds them (for example the query `config settings`). `tools.config_get.enabled` and `tools.config_set.enabled` (both default on) switch them off; with `tools.tool_search.enabled` off neither is registered. An embedding program gets them only when it sets the `config` key to its config file.

`config_get` reads values and structure together:

- No `path`: the top-level sections, each with a one-line description.
- A section (`llm`, `tools.bash`, `telegram`): every key under it. A key (`llm.model`): that key. A path inside a value the config sets (`llm.profiles.cheap`, `mcp.servers.0`) works too.
- Each key has its value as written (`${VAR}` and secret references are not expanded), `type`, `default`, `allowed_values`, `min`/`max`, `apply_mode`, `sensitive`, `settable` (with `not_settable_reason`), `env_override` and `comment`. Types, defaults and apply modes come from the field registry (`internal/configsettings/fields.go`); comments come from the embedded `config.example.yaml`, so its keys outside the registry are listed with their comment too. What the config sets outside both is listed as well.
- Secrets are never returned. Every `Sensitive` field, anything under `secrets` and `auth_profiles`, keys named like credentials (`api_key`, `*_token`, `*_secret`, `password`, ...), header and environment values, `${secret:...}` and `${aws-sm:...}` references anywhere, and any value that holds a secret's value (a copy, or a YAML alias) read `********`; a secret key also says `secret: {set, source}` with `source` one of `literal`, `env`, `secret_store`, `aws_secrets_manager`, `template` or `env_override`. Environment variable names and secret ids of secret keys are not shown.

`config_set` sets one key (`path`, `value` read as YAML like `morph config set`) or removes it (`unset: true`):

- It always asks for approval, through the guard's forced approvals (`guard/forced.go`), even with `guard.enabled` off; without an approval store it is denied. The approval shows the key, its current value and the new one, secrets masked (the approval card lists these instead of the call's parameters, and logs and tool events withhold the value). A denied approval changes nothing. Codemode scripts cannot call it.
- Only the owner in a private conversation: refused in group chats, for contacts, in subtasks, in runs that do not say who they talk to (`morph run`, the runtime API), and never registered for heartbeat and scheduled runs.
- Refused before asking: keys outside the field registry; `guard`, `secrets`, `auth_profiles`, `console`, `server.auth_token`, `llm.endpoint` and every other `endpoint`/`base_url`/`service_url`, `llm.profiles`, `llm.headers`, `mcp`, `*.owners`, `admins`, `tools.*.deny_paths`, `tools.*.injected_env_vars`, `tools.*.elevation`, `tools.coder.bypass_approvals`, `logging.redact_keys`, `workspace_dir`, `file_cache_dir`, `file_state_dir` (and anything that holds one of them); keys an environment variable sets; values of the wrong kind, outside the allowed values or range; a route that names a missing profile; values that hold the `********` mask, a `${secret:...}` reference, or a `${...}` reference anywhere but as the whole value of a secret key; credential, header or endpoint keys inside a structured value.
- A secret key's plain-text value goes to the system keyring (`configsettings.ProtectSecrets`) and the config keeps a `${secret:...}` reference; without a keyring (or with `MISTER_MORPH_DISABLE_KEYRING`) only a whole `${ENV_NAME}` or `${aws-sm:...}` reference is accepted. A replaced keyring entry is deleted.
- The change is saved like a Console settings change, as the agent's (`updated_by = 'agent'` in `agent.db`); the Console reloads its runtimes right away, the channel runtimes on their next config check. The result has `apply_mode` (`immediate`, `next_generation`, `runtime_restart` or `process_restart`) and an `apply_note` saying what the user still has to do.

## `contacts_list`

Purpose: list the agent's contacts: people and agents it can reach.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `status` | `string` | No | `active` | `active`, `inactive` or `all`. |
| `kind` | `string` | No | All | `human` or `agent`. |
| `channel` | `string` | No | All | Only contacts on this channel (`telegram`, `slack`, `agentlink`, ...). |
| `limit` | `integer` | No | `50` | Most contacts to return (at most 200). |

Returns JSON: `count`, `total`, `truncated` and `contacts`, each with its `contact_id`, `nickname`, `kind`, `channel`, `status`, `owner`, `paired`, channel identifiers and `last_interaction_at`.

Notes:

- Registered whenever the runtime has a contacts folder. It replaces reading `contacts/ACTIVE.md` and `INACTIVE.md` with `read_file`; those files no longer exist (they are imported into `agent.db` once and kept as `*.imported`).

## `contacts_send`

Purpose: send one message or one local file to one or more contacts (auto-routed via Telegram/Slack/LINE/Lark/Discord/Mixin/WeChat/WhatsApp).

Contact profile maintenance:

- To find contacts, use `contacts_list`. Contacts are rows of `<file_state_dir>/agent.db`, not files; the owner edits them in the Console (one contact's YAML at a time) or with `morph state export` / `import`.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `contact_id` | `string` | Yes | None | Target contact ID. Multiple contacts may be passed as comma-separated values. |
| `chat_id` | `string` | No | Empty | Optional chat hint (for example `tg:-1001234567890`, `slack:T001:C002`, `line:Cgroup001`). |
| `content_type` | `string` | No | `application/json` | Payload type; must be envelope JSON type. |
| `message_text` | `string` | Conditionally required | None | Message text; the tool wraps it into an envelope. With `path`, the file's optional caption. |
| `message_base64` | `string` | Conditionally required | None | base64url-encoded envelope JSON. Cannot be combined with `path`. |
| `path` | `string` | No | None | A local file to send, under `file_cache_dir` or the task's workspace directory. |
| `filename` | `string` | No | Basename of `path` | Display filename for `path`; requires `path`. |
| `session_id` | `string` | No | Empty | Session ID (UUIDv7). `contacts_send` always sends `chat.message`. |
| `reply_to` | `string` | No | Empty | Optional reply target `message_id`. |

Constraints:

- Can be disabled via `tools.contacts_send.enabled`.
- Awareness runs (heartbeat, cron) see it in every request when `tools.contacts_send.enabled=true`.
- Ordinary runs (Console chat, Telegram, Slack, Discord, LINE, Lark and the other channel runtimes, the CLI and the embedding runtime) never get it in their first request. With `tools.contacts_send.enabled=true` and `tools.tool_search.enabled=true` (both default on), it is a deferred tool: `tool_search` finds it (for example the query `contacts send` or `contacts_send`), and from the next step it is called like any tool. As with other found tools, it stays visible for the rest of the conversation (`/reset` forgets it). With tool search off, ordinary runs have no `contacts_send` at all. Subtasks never get it.
- Group chats (Telegram groups, Slack channels, Discord servers, LINE and Lark groups, Mixin groups) and Bluesky/X public mentions are the exception: there `contacts_send` is not offered to `tool_search` and cannot be called unless the message names `$contacts_send`.
- Finding it changes nothing about a send: the same recipient checks, current-conversation block, guard rules, credentials, cooldowns and delivery records apply as in awareness runs.
- Explicit `$contacts_send` opt-in can expose it for the current task even when `tools.contacts_send.enabled=false`; it does not bypass selected tool allowlists, guard rules, credentials, or runtime prerequisites.
- Failures: an unknown contact, a contact without a reachable route, a `chat_id` the contact cannot receive in, and a text message (no `path`) to the person of the current conversation, by `contact_id` or `chat_id`, fail with an error and send nothing. The current-conversation error says why (the text would repeat the task's own reply) and what to do instead: answer in the conversation, or pass `path` to send a file. A file may go to that person (see [Sending a file](#sending-a-file)). When the channel rejects a delivery (for example a missing channel credential or a blocked bot), the result's `outcome` has `accepted: false` and an `error`.
- `contacts_send` always uses topic `chat.message` (caller does not pass `topic`).
- Telegram text messages render Markdown (bold, italic, code, links) as Telegram HTML, as Telegram channel replies do. If Telegram rejects the markup, the text is sent again as plain text. Write plain Markdown, not Telegram MarkdownV2 escapes. File captions stay plain text.
- If cross-session forwarding is needed in group chat (for example, explicit "DM someone"), trigger it via explicit task/command, not by routing ordinary group replies to `contacts_send`.
- If `chat_id` is provided:
  - Multiple contacts: the explicit chat must be a shared route for every contact; otherwise the tool returns an error instead of choosing another chat. Telegram, Slack, and Lark add mentions; LINE sends to the shared chat without mentions.
  - Single contact:
    - Telegram: used only when matching `tg_private_chat_id` or `tg_group_chat_ids`; otherwise falls back to `tg_private_chat_id`.
    - Slack: used directly as `slack:<team_id>:<channel_id>`.
    - LINE: used only when matching `line_chat_ids`; otherwise falls back to `line_user_id`.
    - If still unavailable, the tool returns an error.
- Without `path`, at least one of `message_text` or `message_base64` is required.
- `content_type` defaults to `application/json`, and must be `application/json` (parameters allowed, for example `application/json; charset=utf-8`).
- If `message_base64` is provided, decoded payload must be envelope JSON containing `message_id` / `text` / `sent_at (RFC3339)` / `session_id (UUIDv7)`.
- Sending to human contacts is allowed by default; actual deliverability still depends on sendable targets in contact profiles (private/group chat IDs).

### Sending a file

Pass `path` to send one file. The destination is chosen exactly as for text; the file never picks a different channel.

```json
{
  "contact_id": "tg:123456",
  "path": "file_cache_dir/reports/weekly.pdf",
  "filename": "weekly-report.pdf",
  "message_text": "This week's report."
}
```

- Where the file may come from: `file_cache_dir` and the task's workspace directory (the attached workspace, or the default `workspace_dir`). `file_cache_dir/...` and `workspace_dir/...` aliases pick a root; a relative path is looked up in `file_cache_dir`, then in the workspace; an absolute path must lie inside one of them after resolving symlinks. `file_state_dir` is never allowed, even inside a workspace. A file produced elsewhere must be copied into `file_cache_dir` first.
- Rejected before anything is sent: an empty or non-string `path`, `filename` without `path`, `path` with `message_base64`, a non-string `message_text`, a directory, a missing file, a file outside both roots, a symlink that escapes them, a file over 20 MiB to a chat channel, and a file over the Agent Link route's limit (64 MiB streamed, 2 MiB otherwise).
- A file may go to the person of the current conversation (the user of a direct chat, the chat itself by `chat_id`, a Bluesky or X post's author), alone or in a batch, with or without a caption; a text message to them stays refused. An invalid or empty `path` fails as above and never turns a text message into an allowed one. The file goes through the same roots, size limits, channel support, cooldowns, delivery records and audit as any other file; Bluesky and X direct messages cannot carry files, so a file to a post's author fails there.
- One file per call. `message_text` is optional; when given it is a caption:

| Channel | File | Caption |
|---|---|---|
| Telegram | Always a document (`sendDocument`), keeping a topic target | Attached up to 1,024 characters; longer text follows as a message |
| Slack | External upload shared in the channel | The upload's initial comment |
| Lark | File message to the chat or user | Always a separate message after the file |
| Discord | Attachment in the channel, opening a DM when needed; at most 10 MiB | Attached up to 2,000 characters; longer text follows as a message |
| Mixin | Data attachment in the conversation | Always a separate message after the file |
| WeChat, WhatsApp | Through the running channel runtime, as `send_file` / `send_file` do (images and videos as media) | As their file transports handle it |
| Agent Link (`mm:` contacts) | The file's bytes over the Agent Link connection, saved in the other agent's `file_cache_dir`; at most 64 MiB when every hop streams files, otherwise 2 MiB | The message text |
| LINE | Not supported; the call fails | |

- With several contacts, each planned destination gets one upload, and mentions are kept in its caption.
- The file is checked again just before the upload. A file that disappeared or changed fails that delivery; the caption is never sent alone.
- When the file goes out but a caption sent after it fails, the outcome has `accepted: true`, `partial: true` and an `error`. The delivery counts as sent, so it is not uploaded again.
- WeChat and WhatsApp need their runtime running in the same process; no other account connection is made.
- The delivery record in the contacts outbox keeps the file's path, display filename, size and SHA-256, never its bytes.
- With the guard enabled, every file send writes a `FileSend` event to the guard audit log with the recipients, resolved path, display filename, size, SHA-256 and status (`sent`, `partial`, `failed`, or `attached` for a file attached to an Agent Link answer). File sends follow the same guard and approval rules as text; scheduled tasks need no extra approval.

A scheduled or awareness task can ask for a file explicitly:

```text
$contacts_send Generate the weekly report, save it under file_cache_dir, and send the PDF
to tg:123456. Include a short summary as message_text.
```

The reference only makes `contacts_send` available; the model still calls it with the file and recipient. A cron notification target alone never sends an attachment.

## `agent_send`

Purpose: send a message to one or more active Agent contacts.

Parameters and return values are those of `contacts_send`. `path` and `filename` send a file to Agent Link contacts only (see [Agent Link](#agent-link)); a file to an Agent on another channel is rejected, and `contacts_send` sends it there. Both tools use the same parsing, routing, batch planning, message envelope, sender, and outbox implementation.

Constraints:

- Registered only when at least one active Contact is `kind: agent` (a query on the `contacts` table). Availability is refreshed when preparing each task.
- Every target is checked again immediately before planning the send. All targets must still be active and have `kind: agent`.
- Protocol references such as `tg:@username` must resolve to an active Agent Contact. Arbitrary chat or user addresses cannot bypass the check.
- A multi-target call is rejected before sending anything when any target is not an active Agent.
- `agent_send` has no separate enable key. Removing or deactivating all Agent Contacts makes it unavailable.
- Cooldown: after a send to an Agent contact (through `agent_send` or `contacts_send`), that contact cannot receive another send until `contacts.agent_send.cooldown` has passed (default `30s`, `0` disables it). A call that targets a contact still cooling down is rejected before anything is sent. A failed send to an Agent contact does not start a cooldown.
- `contacts_send` registration and group-chat restrictions are unchanged.

### Agent Link

Agents that a Console connects to as endpoints reach each other over Agent Link, a built-in channel, even when they share no chat platform. Every runtime that serves its runtime API gets an active Agent contact `mm:<instance_id>` for each other agent the Console reaches (named after that agent), so `agent_send` works with them like any other Agent contact. See `docs/feat/feat_20261011_agentlink_channel.md`.

- The Console carries the messages; agents never see its URLs or tokens.
- A message not delivered within about 10 seconds stays queued in the sender's runtime, and the outcome has `"queued": true`. It is delivered when a Console reaches the target, or fails after `contacts.agent_link.queue_ttl`.
- The receiving agent runs the message as a task and sends its final answer back as the reply. An answer it receives starts no reply back.
- `agent_send` waits for the answer, up to `contacts.agent_link.reply_timeout` (default `2m`), and returns it as `reply.text`; the agent can ask a follow-up or answer its user. With no answer by then, `reply.status` is `pending`, and the answer arrives later in the conversation that asked (a Console topic). `contacts_send` does not wait.
- In the Console chat, the messages between the agents show before the task's reply.
- An `agent_send` over Agent Link from a task a person started skips the `agent_send` cooldown; one from a task another agent started does not.
- In the Console, what another agent sends the local agent, and the answers, are kept in a topic per agent. The topic sidebar's agents button lists them, with each agent's avatar; they stay out of the date and tag views.
- Files: `path` (with optional `filename` and `message_text`) sends one file per call, under `file_cache_dir` or the workspace: at most 64 MiB when the agent's runtime and the Console that reaches it stream files (`files_stream`), otherwise 2 MiB; the error names the limit that applied. The bytes travel over the Agent Link connection (streamed in binary chunks, or inline in the message on an older route); the other agent gets the file in its own `file_cache_dir/agentlink/<instance_id>/` with its display name, media type, size and SHA-256, and its task is told where it is. `reply.attachments` lists files the agent sent back.
- A task answering an Agent Link message attaches a file to its answer with `agent_send` to the agent that asked, with `path`; the result is `status: attached_to_reply`.
- An agent whose runtime or Console predates file transfer gets an explicit error instead of the file; text still reaches it. Limits, cleanup and failure behavior: `docs/feat/feat_20261111_agentlink_file_transfer.md` (inline) and `docs/feat/feat_20261113_agentlink_streamed_files.md` (streamed).
- Received files are untrusted data; agents are told not to run them or follow instructions inside them.
- Sending needs a running runtime (Console or a channel runtime with its runtime API); a one-off `run` cannot send to `mm:` contacts.

## `spawn`

Purpose: run a self-contained subtask in a sub-agent with its own context and a restricted tool whitelist, and get back a short result instead of the intermediate content. The call blocks until the sub-agent finishes; sub-agents run one at a time. When `spawn` is available, the prompt asks the model to delegate subtasks that would produce a lot of intermediate content (searching and filtering web pages, reading long logs, inspecting many files) and to ask for a concise conclusion with the evidence needed to check it.

Parameters:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `task` | `string` | Yes | Task prompt. The sub-agent does not see the conversation, so it carries the background, goal and what to return. |
| `tools` | `array<string>` | Yes | Tool whitelist, taken from the parent's registry. Include `spawn` to let the sub-agent start its own sub-agents (see [Nesting](#nesting)). |
| `model_profile` | `string` | No | Model profile the sub-agent runs on. Omit it to keep the parent's configuration (including a manually selected profile or the weighted candidate picked for the run). |
| `output_schema` | `string` | No | Schema identifier; the sub-agent's `output` must then be JSON. |
| `observe_profile` | `string` | No | Local observer profile: `default`, `long_shell` or `web_extract`. |

The `model` parameter was replaced by `model_profile`; passing `model` returns an error.

`model_profile`:

- The sub-agent uses the profile's own provider, connection, credentials, model and inference settings, including reasoning effort; the parent's reasoning effort override is not passed on. `default` means the top-level `llm.*` config, not "same as the parent".
- If the profile fails at request time, the sub-agent falls back to `llm.routes.main_loop.fallback_profiles` (which can include the parent's model).
- The profile must have the `text` ability (`abilities` empty or containing `text`) and must not be Evaluate-only (`typesafe`). An unknown profile, a profile that fails to resolve or cannot run a subtask, or a runtime without profile support returns a failed envelope without starting the sub-agent; its `error` says why and suggests another profile or omitting `model_profile`.
- Selecting a profile affects only that subtask, not the session's main profile.

Result: a JSON envelope with `task_id`, `status` (`done` or `failed`), `summary`, `output_kind` (`text` or `json`), `output_schema`, `output` and `error`.

### Nesting

Subtasks nest at most two levels deep. The main task is depth 0; its sub-agents run at depth 1, and theirs at depth 2. The limit is fixed and not configurable.

- A sub-agent gets its own `spawn` only when the parent lists `spawn` in `tools` and the sub-agent runs at depth 1. With it comes `list_model_profiles` when profiles are available, and its `model_profile` works the same way as the parent's.
- A sub-agent's `tools` are taken from its own whitelist, so a depth 2 sub-agent never gets a tool its parent did not have.
- A depth 2 sub-agent has no `spawn`: `spawn` in the whitelist a depth 1 sub-agent passes is ignored. A subtask started at depth 2 any other way returns a failed envelope with `subtask depth limit reached (max=2)` and does not run.
- `coder` and `bash` with `run_in_subtask` count toward the same limit: from depth 0 or 1 they run in a subtask; at depth 2 `coder` fails and `bash` runs the command in the current subtask.
- Cancelling the main task cancels every level, and each level gets its child's envelope as the `spawn` result.

## `list_model_profiles`

Purpose: list the model profiles a `spawn` subtask can select. No parameters; read-only; makes no model requests.

Registered next to `spawn` only when more than one profile can run a subtask: `default` plus every named profile whose `abilities` include `text` (empty means `text`), excluding Evaluate-only `typesafe` profiles. The prompt tells the model to call it when it wants a different configuration for a subtask and to reuse an earlier result.

```json
{
  "profiles": [
    {"name": "default", "model": "gpt-5.4", "description": "Complex analysis.", "current": true},
    {"name": "cheap", "model": "gpt-4.1-mini", "description": "Extraction and short summaries; favors speed."},
    {"name": "broken", "model": "", "description": "", "error": "llm.profiles.broken.request_timeout: ..."}
  ]
}
```

- Order: `default` first, then named profiles by name.
- `description` comes from `llm.description` / `llm.profiles.<name>.description`; empty when not set.
- `current` marks the profile the parent is running on.
- A profile that fails to resolve is listed with `error`; the others are still listed. Credentials, headers and endpoints are never returned.

## `codemode`

Purpose: run a JavaScript program that calls the run's tools, so the model can chain and filter several tool calls in one step and keep intermediate results out of the conversation. It runs on [moejs](https://github.com/Calcium-Ion/moejs), inside the process.

Parameters:

| Parameter | Type | Required | Description |
|---|---|---|---|
| `code` | `string` | Yes | JavaScript, run as the body of an async function: top-level `await` and `return` work. No TypeScript, no Markdown fences. |

```js
const [readme, mod] = await Promise.all([
  tools.read_file({path: "README.md"}),
  tools.read_file({path: "go.mod"}),
]);
text(readme.split("\n")[0]);
return mod.match(/^go .*/m)[0];
```

What a script has:

| Global | Contract |
|---|---|
| `tools[name](args)` | Calls a tool with an argument object; resolves to its text result, rejects with a `ToolError` (`name`, `tool`, `message`) |
| `searchTools(query, {server, limit})` | Finds tools and servers; tools it finds can be called in the same script |
| `describeTool(name)` | `{name, description, inputSchema}` of a callable tool |
| `text(value)`, `console.log(...values)` | Append to the output; non-strings as JSON |
| `return value` | Appended like `text` |

Nothing else: no timers, imports, `eval`, filesystem, network, environment or process access except through tools. Builtins are frozen.

Result (the tool's observation):

```json
{
  "status": "completed",
  "output": ["# MisterMorph", "go 1.25.0"],
  "calls": [{"tool": "read_file", "outcome": "succeeded"}, {"tool": "read_file", "outcome": "succeeded"}],
  "elapsed_ms": 3
}
```

- `status`: `completed`, `failed`, `timed_out`, `cancelled`, `output_limit`, `memory_limit` or `requires_direct_call`; `error` says why when not completed.
- `calls`: each operation with `succeeded`, `failed`, `denied`, `not_started`, `cancelled` or `requires_approval`. Only the output reaches the model; intermediate results do not.
- `pending_call`: with `requires_direct_call`, the call the model must make directly.

Rules:

- Every call goes through the same checks as a direct call: visibility, `tool_repeat_limit`, guard pre-check and output redaction, hooks, events and audit. A guard deny rejects the call's promise; a call that needs approval stops the script with `requires_direct_call`. The script is never rerun automatically.
- Scripts cannot call `codemode`, `tool_search`, `plan_create`, `message_react`, `bash`, `powershell`, `skill_install`, `config_set`, tools that end the run, or tools that implement `tools.CodeModeExcluded` and return true (for example an embedder's tool that asks the user before it acts).
- With tool search, a script can call MCP tools the model already sees, and tools its own `searchTools` found (a `server` search connects that server). Those stay invisible to the model and are not remembered by the conversation.
- Read-only (parallel-safe) calls run concurrently up to `max_parallel_calls`; any other call runs alone, in issue order.
- When the script ends, calls it issued but that have not started are dropped (`not_started`); started calls finish within the deadline. A timeout or cancellation cancels them.
- One script is one step toward `max_steps`.
- Limits: `timeout` (default 120s, also bounded by the task deadline), `max_tool_calls` (256, including searches), `max_parallel_calls` (4); source 64 KiB, one tool argument object 256 KiB, one result 1 MiB, all results 8 MiB, output 64 KiB or 256 items.
- Memory is watched, not capped: while scripts run, the process heap is sampled every 100 ms, each result logs its approximate heap growth, and running scripts stop with `memory_limit` when the heap passes 90% of `GOMEMLIMIT` (2 GiB without one). A single large allocation can still exhaust the process. Set `tools.codemode.enabled: false` to turn it off.
- In the Console activity panel a script is one entry with its calls listed under it; the CLI prints them indented under `▸ codemode`.
- Tool events, `tool_call_params` logs and the `chat` command's tool activity line and transcript never show a script's source, only `code_chars` and `code_lines`: a script can pass secrets to its calls (such as `job_manage` `bash_env` values) through any expression, which is only known once it runs. Each call the script makes is shown on its own, with that tool's redaction. The conversation and run state keep the source.

## `plan_create`

Purpose: generate execution-plan JSON. Usually called by the system for complex tasks.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `task` | `string` | Yes | None | Task description to plan. |
| `max_steps` | `integer` | No | Config default (`tools.plan_create.max_steps`, usually 6) | Maximum number of steps. |
| `style` | `string` | No | Empty | Plan style hint, for example `terse`. |
| `model` | `string` | No | Current default model | Override model for plan generation. |

## `image_generate`

Purpose: generate one image from a text prompt and save it as a local file.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | `string` | Yes | None | Image generation prompt. |
| `output_path` | `string` | No | `file_cache_dir/images/<timestamp>-<id>.<ext>` | Output path. Supports `workspace_dir/...` and `file_cache_dir/...`; relative paths resolve under `file_cache_dir/images/`. |

Constraints:

- Controlled by `tools.image_generate.enabled`.
- Registered only when the current task has explicit image intent, or when the current session has retained image-tool state.
- Uses the profile `llm.routes.image` points at, or the current runtime model when no image route is set.
- `openai_codex` and `xai_oauth` do not provide image-generation credentials. With either OAuth chat provider, route images to a profile with an OpenAI, Gemini, or Cloudflare key.
- Produces exactly one image.
- Output files are limited to `workspace_dir` and `file_cache_dir`.
- Returned MIME type decides the extension. A conflicting `output_path` extension returns an error.

## `image_edit`

Purpose: edit one local image from a text prompt and save one output image.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `prompt` | `string` | Yes | None | Image edit prompt. |
| `input_path` | `string` | No | None | Input image path. Supports `workspace_dir/...` and `file_cache_dir/...`. Required unless `use_active_image` is true. |
| `use_active_image` | `boolean` | No | `false` | Use the current session active image as input when `input_path` is empty. |
| `output_path` | `string` | No | `file_cache_dir/images/<timestamp>-<id>.<ext>` | Output path. Supports `workspace_dir/...` and `file_cache_dir/...`; relative paths resolve under `file_cache_dir/images/`. |

Constraints:

- Controlled by `tools.image_edit.enabled`.
- Registered only when the current task has explicit image intent, or when the current session has retained image-tool state.
- Uses the profile `llm.routes.image` points at, or the current runtime model when no image route is set.
- `openai_codex` and `xai_oauth` do not provide image-editing credentials. With either OAuth chat provider, route images to a profile with an OpenAI, Gemini, or Cloudflare key.
- Accepts exactly one input image and produces exactly one output image.
- Input and output files are limited to `workspace_dir` and `file_cache_dir`; `file_state_dir` is not accepted.
- Current-turn channel image attachments are exposed to the model as `file_cache_dir/...` aliases when available.
- Successful `image_generate` and `image_edit` calls set the current session active image when the runtime has a conversation scope.

## `send_file` (Telegram)

Purpose: send a local cached file (document) to the current Telegram chat.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | None | Local file path. Supports absolute path or relative path under `file_cache_dir`. |
| `filename` | `string` | No | `basename(path)` | File name displayed in Telegram. |
| `caption` | `string` | No | Empty | Optional file caption. |

Constraints:

- Available only in Telegram mode.
- `path` supports `file_cache_dir/<path>` alias form.
- Only files under `file_cache_dir` can be sent; directories return errors.
- File size is limited by tool cap (currently 20 MiB by default).

## `send_photo` (Telegram)

Purpose: send a local cached image to the current Telegram chat as an inline photo.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `path` | `string` | Yes | None | Local image path. Supports absolute path or relative path under `file_cache_dir`. |
| `caption` | `string` | No | Empty | Optional photo caption. |

Constraints:

- Available only in Telegram mode.
- `path` supports `file_cache_dir/<path>` alias form.
- Only files under `file_cache_dir` can be sent; directories return errors.
- File size is limited by tool cap (currently 20 MiB by default).
- This tool sends the image as an inline Telegram photo; use `send_file` when the user should receive it as a document.

## `send_voice` (Telegram)

Purpose: send a Telegram voice message from a local voice file.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `chat_id` | `integer` | No | Current context chat | Target Telegram `chat_id`. Required if there is no active chat context. |
| `path` | `string` | Yes | None | Local voice file path (recommended `.ogg`/Opus). Supports absolute path or relative path under `file_cache_dir`. |
| `filename` | `string` | No | `basename(path)` | File name displayed in Telegram. |

Constraints:

- Available only in Telegram mode.
- Only local-file sending is supported; inline text-to-speech is not supported.
- Local files are limited to `file_cache_dir` and file-size caps (currently 20 MiB by default).

## `message_react` (Telegram)

Purpose: add emoji reactions to Telegram messages.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `chat_id` | `integer` | No | Current context chat | Target Telegram `chat_id`. |
| `message_id` | `integer` | No | Trigger message ID | Message ID to react to. |
| `emoji` | `string` | Yes | None | Reaction emoji. |
| `is_big` | `boolean` | No | Empty | Whether to use Telegram large reaction style. |

Constraints:

- Available only in Telegram mode.
- Requires `message_id` context in Telegram mode (or explicit `message_id` input).

## `message_react` (Slack)

Purpose: add emoji reactions to Slack messages.

Parameters:

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `channel_id` | `string` | No | Current context channel | Target Slack `channel_id`. |
| `message_ts` | `string` | No | Trigger message ts | Message timestamp (`ts`) to react to. |
| `emoji` | `string` | Yes | None | Slack emoji name (for example `thumbsup` or `:thumbsup:`). |

Constraints:

- Available only in Slack mode.
- Requires `channel_id` and `message_ts` context in Slack mode (or explicit params).
- Emoji must be a valid Slack emoji name format (not raw Unicode emoji).
- If emoji catalog is loaded, emoji name must exist in current workspace catalog.
- Subject to `allowed_channel_ids` restriction when configured.

## Notes

- Runtime parameter validation follows each tool's `ParameterSchema()` and execution-time checks inside the corresponding tool/runtime handlers.
- If a tool is disabled by configuration, it returns a `... tool is disabled` error.

## TODO

- Refactor duplicated Phase C task-registry shaping logic across Telegram/Slack/LINE runtime tool re-registration into a shared helper.
