# Mister Morph

Unified Agent CLI + reusable Go agent core.

Other languages: [简体中文](docs/zh-CN/README.md) | [日本語](docs/ja-JP/README.md)

## Table of contents

- [Why Mister Morph](#why-mistermorph)
- [Quickstart](#quickstart)
- [Supported Models](#supported-models)
- [Daemon mode](#daemon-mode)
- [Telegram bot mode](#telegram-bot-mode)
- [Embedding](#embedding-to-other-projects)
- [Built-in Tools](#built-in-tools)
- [Skills](#skills)
- [Security](#security)
- [Troubleshoots](#troubleshoots)
- [Debug](#debug)
- [Configuration](#configuration)

## Why Mister Morph

What makes this project worth looking at:

- 🧩 **Reusable Go core**: Run the agent as a CLI, or embed it as a library/subprocess in other apps.
- 🤝 **Mesh Agent Exchange Protocol (MAEP)**: You and your amigos run multiple agents and want them to message each other: use the MAEP, a p2p protocol with trust-state and audit trails. (see [docs/maep.md](docs/maep.md), WIP).
- 🔒 **Serious secure defaults**: Profile-based credential injection, Guard redaction, outbound policy controls, and async approvals with audit trails (see [docs/security.md](docs/security.md)).
- 🧰 **Practical Skills system**: Discover + inject `SKILL.md` from `file_state_dir/skills`, with simple on/off control (see [docs/skills.md](docs/skills.md)).
- 📚 **Beginner-friendly**: Built as a learning-first agent project, with detailed design docs in `docs/` and practical debugging tools like `--inspect-prompt` and `--inspect-request`.

## Quickstart

### Step 1: Install

Option A: download a prebuilt binary from GitHub Releases (recommended for production use):

```bash
curl -fsSL -o /tmp/install-mistermorph.sh https://raw.githubusercontent.com/quailyquaily/mistermorph/refs/heads/master/scripts/install-release.sh
sudo bash /tmp/install-mistermorph.sh
```

The installer supports:

- `bash install-release.sh <version-tag>`
- `INSTALL_DIR=$HOME/.local/bin bash install-release.sh <version-tag>`

Option B: install from source with Go:

```bash
go install github.com/quailyquaily/mistermorph@latest
```

### Step 2: Install the Agent requirements and built-in skills

```bash
mistermorph install
# or
mistermorph install <dir>
```

The `install` command installs required files and built-in skills under `~/.morph/skills/` (or a specified directory via `<dir>`).

### Step 3: Setup an API key

Open the config file `~/.morph/config.yaml` and set your LLM provider API key, e.g. for OpenAI:

```yaml
llm:
  provider: "openai"
  endpoint: "https://api.openai.com/v1"
  model: "gpt-5.2"
  api_key: "YOUR_OPENAI_API_KEY_HERE"
```

Mister Morph also supports Azure OpenAI, Anthropic Claude, AWS Bedrock, and others (see `assets/config/config.example.yaml` for more options).

### Step 4: One-time Run 

```bash
mistermorph run --task "Hello!"
```

## Supported Models

> Model support may vary by specific model ID, provider endpoint capability, and tool-calling behavior.

| Model family | Model range | Status |
|---|---|---|
| GPT | `gpt-5*` | ✅ Full |
| GPT-OSS | `gpt-oss-120b` | ✅ Full |
| Claude | `claude-3.5+` | ✅ Full |
| DeepSeek | `deepseek-3*` | ✅ Full |
| Gemini | `gemini-2.5+` | ✅ Full |
| Kimi | `kimi-2.5+` | ✅ Full |
| MiniMax | `minimax* / minimax-m2.5+` | ✅ Full |
| GLM | `glm-4.6+` | ✅ Full |
| Cloudflare Workers AI | `Workers AI model IDs` | ⚠️ Limited (no tool calling) |

## Telegram bot mode

Run a Telegram bot (long polling) so you can chat with the agent from Telegram:

Edit the config file `~/.morph/config.yaml` and set your Telegram bot token:

```yaml
telegram:
  bot_token: "YOUR_TELEGRAM_BOT_TOKEN_HERE"
  allowed_chat_ids: [] # add allowed chat ids here
```

```bash
mistermorph telegram --log-level info
```

Notes:
- Use `/id` to get the current chat id and add it to `allowed_chat_ids` for allowlisting.
- Use `/ask <task>` in groups.
- In groups, the bot also responds when you reply to it, or mention `@BotUsername`.
- You can send a file; it will be downloaded under `file_cache_dir/telegram/` and the agent can process it. The agent can also send cached files back via `telegram_send_file`, and send voice messages via `telegram_send_voice` from local voice files in `file_cache_dir`.
- The last loaded skill(s) stay “sticky” per chat (so follow-up messages won’t forget SKILL.md); `/reset` clears this.
- If you configure `telegram.aliases`, the default `telegram.group_trigger_mode=smart` only triggers on aliases when the message looks like direct addressing. Alias hits are LLM-validated in smart mode.
- `telegram.group_trigger_mode=talkative` runs addressing LLM on every group message; acceptance uses `telegram.addressing_confidence_threshold` and rejects when `interject` less than `telegram.addressing_interject_threshold`.
- Use `/reset` in chat to clear conversation history.
- By default it runs multiple chats concurrently, but processes each chat serially (config: `telegram.max_concurrency`).


## Daemon mode

Run a local HTTP daemon that accepts tasks sequentially (one-by-one), so you don’t need to restart the process for each task.

Start the daemon:

```bash
export MISTER_MORPH_SERVER_AUTH_TOKEN="change-me"
mistermorph serve --server-port 8787 --log-level info
```

Submit a task:

```bash
mistermorph submit --server-url http://127.0.0.1:8787 --auth-token "$MISTER_MORPH_SERVER_AUTH_TOKEN" --wait \
  --task "Summarize this repo and write to ./summary.md"
```

## Embedding to other projects

Two common integration options:

- As a Go library: see `demo/embed-go/`.
- As a subprocess CLI: see `demo/embed-cli/`.

For Go-library embedding with built-in wiring, use `integration`:

```go
cfg := integration.DefaultConfig()
cfg.BuiltinToolNames = []string{"read_file", "url_fetch", "todo_update"} // optional; empty = all built-ins
cfg.Inspect.Prompt = true   // optional
cfg.Inspect.Request = true  // optional
cfg.Set("llm.api_key", os.Getenv("OPENAI_API_KEY"))

rt, err := integration.New(cfg)
if err != nil { /* ... */ }

reg := rt.NewRegistry() // built-in tools wiring
prepared, err := rt.NewRunEngineWithRegistry(ctx, task, reg)
if err != nil { /* ... */ }
defer prepared.Cleanup()

final, runCtx, err := prepared.Engine.Run(ctx, task, agent.RunOptions{Model: prepared.Model})
_ = final
_ = runCtx
```

## Built-in Tools

Core tools available to the agent:

- `read_file`: read local text files.
- `write_file`: write local text files under `file_cache_dir` or `file_state_dir`.
- `bash`: run a shell command (disabled by default).
- `url_fetch`: HTTP fetch with optional auth profiles.
- `web_search`: web search (DuckDuckGo HTML).
- `plan_create`: generate a structured plan.

Tools only available in Telegram mode:

- `telegram_send_file`: send a file in Telegram.
- `telegram_send_voice`: send a voice message in Telegram.
- `telegram_react`: add an emoji reaction in Telegram.

Please see [`docs/tools.md`](docs/tools.md) for detailed tool documentation.

## Skills

`mistermorph` discovers skills under `file_state_dir/skills` (recursively), and injects selected `SKILL.md` content into the system prompt.

By default, `run` uses `skills.mode=on`, which loads skills from `skills.load` and optional `$SkillName` references (`skills.auto=true`).

Docs: [`docs/skills.md`](docs/skills.md).

```bash
# list available skills
mistermorph skills list
# Use a specific skill in the run command
mistermorph run --task "..." --skills-mode on --skill skill-name
# install remote skills 
mistermorph skills install <remote-skill-url> 
```

### Security Mechanisms for Skills

1. Install audit: When installing remote skills, Mister Morph will preview the skill content and do a basic security audit (e.g., look for dangerous commands in scripts) before asking for user confirmation.
2. Auth profiles: Skills can declare required auth profiles in the `auth_profiles` field. The agent will only use skills whose auth profiles are configured on the host, preventing accidental secret leaks (see `assets/skills/moltbook` and the `secrets` / `auth_profiles` sections in the config file).

## Security

Recommended systemd hardening and secret handling: [`docs/security.md`](docs/security.md).

## Troubleshoots

Known issues and workarounds: [`docs/troubleshoots.md`](docs/troubleshoots.md).

## Debug

### Logging

There is an argument `--log-level` set for logging level and format:

```bash
mistermorph run --log-level debug --task "..."
```

### Dump internal debug data

There are 2 arguments `--inspect-prompt`/`--inspect-request` for dumping internal state for debugging:

```bash
mistermorph run --inspect-prompt --inspect-request --task "..."
```

These arguments will dump the final system/user/tool prompts and the full LLM request/response JSON as plain text files to `./dump` directory. 

## Configuration

`mistermorph` uses Viper, so you can configure it via flags, env vars, or a config file.

- Config file: `--config /path/to/config.yaml` (supports `.yaml/.yml/.json/.toml/.ini`)
- Env var prefix: `MISTER_MORPH_`
- Nested keys: replace `.` and `-` with `_` (e.g. `tools.bash.enabled` → `MISTER_MORPH_TOOLS_BASH_ENABLED=true`)


### CLI flags

**Global (all commands)**
- `--config`
- `--log-level`
- `--log-format`
- `--log-add-source`
- `--log-include-thoughts`
- `--log-include-tool-params`
- `--log-include-skill-contents`
- `--log-max-thought-chars`
- `--log-max-json-bytes`
- `--log-max-string-value-chars`
- `--log-max-skill-content-chars`
- `--log-redact-key` (repeatable)

**run**
- `--task`
- `--provider`
- `--endpoint`
- `--model`
- `--api-key`
- `--llm-request-timeout`
- `--interactive`
- `--skills-dir` (repeatable)
- `--skill` (repeatable)
- `--skills-auto`
- `--skills-mode` (`off|on`)
- `--max-steps`
- `--parse-retries`
- `--max-token-budget`
- `--timeout`
- `--inspect-prompt`
- `--inspect-request`

**serve**
- `--server-bind`
- `--server-port`
- `--server-auth-token`
- `--server-max-queue`

**submit**
- `--task`
- `--server-url`
- `--auth-token`
- `--model`
- `--submit-timeout`
- `--wait`
- `--poll-interval`

**telegram**
- `--telegram-bot-token`
- `--telegram-allowed-chat-id` (repeatable)
- `--telegram-alias` (repeatable)
- `--telegram-group-trigger-mode` (`strict|smart|talkative`)
- `--telegram-smart-addressing-max-chars`
- `--telegram-addressing-confidence-threshold`
- `--telegram-addressing-interject-threshold`
- `--telegram-poll-timeout`
- `--telegram-task-timeout`
- `--telegram-max-concurrency`
- `--file-cache-dir`

**skills**
- `skills list --skills-dir` (repeatable)
- `skills install --dest --dry-run --clean --skip-existing --timeout --max-bytes --yes`

**install**
- `install [dir]`

### Environment variables

Common env vars (these map to config keys):

- `MISTER_MORPH_CONFIG`
- `MISTER_MORPH_LLM_PROVIDER`
- `MISTER_MORPH_LLM_ENDPOINT`
- `MISTER_MORPH_LLM_MODEL`
- `MISTER_MORPH_LLM_API_KEY`
- `MISTER_MORPH_LLM_REQUEST_TIMEOUT`
- `MISTER_MORPH_LOGGING_LEVEL`
- `MISTER_MORPH_LOGGING_FORMAT`
- `MISTER_MORPH_SERVER_AUTH_TOKEN`
- `MISTER_MORPH_TELEGRAM_BOT_TOKEN`
- `MISTER_MORPH_GUARD_APPROVALS_SQLITE_DSN`
- `MISTER_MORPH_FILE_CACHE_DIR`

Provider-specific settings use the same mapping, for example:
- `llm.azure.deployment` → `MISTER_MORPH_LLM_AZURE_DEPLOYMENT`
- `llm.bedrock.model_arn` → `MISTER_MORPH_LLM_BEDROCK_MODEL_ARN`

Tool toggles and limits also map to env vars, for example:

- `MISTER_MORPH_TOOLS_BASH_ENABLED`
- `MISTER_MORPH_TOOLS_URL_FETCH_ENABLED`
- `MISTER_MORPH_TOOLS_URL_FETCH_MAX_BYTES`

Secret values referenced by `auth_profiles.*.credential.secret_ref` are regular env vars too (example: `JSONBILL_API_KEY`).

Key meanings (see `assets/config/config.example.yaml` for the canonical list):
- Core: `llm.provider` selects the backend. Most providers use `llm.endpoint`/`llm.api_key`/`llm.model`. Azure uses `llm.azure.deployment` for deployment name, while endpoint/key are still read from `llm.endpoint` and `llm.api_key`. Bedrock uses `llm.bedrock.*`. `llm.tools_emulation_mode` controls tool-call emulation for models without native tool calling (`off|fallback|force`).
- Logging: `logging.level` (`info` shows progress; `debug` adds thoughts), `logging.format` (`text|json`), plus `logging.include_thoughts` and `logging.include_tool_params` (redacted).
- Loop: `max_steps` limits tool-call rounds; `parse_retries` retries invalid JSON; `max_token_budget` is a cumulative token cap (0 disables); `timeout` is the overall run timeout.
- Skills: `skills.mode` controls whether skills are used (`off|on`; legacy `explicit/smart` map to `on`); `file_state_dir` + `skills.dir_name` define the default skills root; `skills.load` always loads specific skills; `skills.auto` additionally loads `$SkillName` references.
- Tools: all tool toggles live under `tools.*` (e.g. `tools.bash.enabled`, `tools.url_fetch.enabled`) with per-tool limits and timeouts.
