# Mister Morph

统一 Agent CLI 与可复用的 Go Agent 核心。

## 目录

- [为什么选择 Mister Morph](#why-mistermorph)
- [快速开始](#quickstart)
- [支持模型](#supported-models)
- [守护进程模式](#daemon-mode)
- [Telegram 机器人模式](#telegram-bot-mode)
- [嵌入到其他项目](#embedding-to-other-projects)
- [内置工具](#built-in-tools)
- [Skills（技能）](#skills)
- [安全性](#security)
- [故障排查](#troubleshoots)
- [调试](#debug)
- [配置](#configuration)

<a id="why-mistermorph"></a>
## 为什么选择 Mister Morph

这个项目值得关注的原因：

- 🧩 **可复用的 Go 核心**：既能把 Agent 当 CLI 运行，也能以库或子进程的方式嵌入到其他应用。
- 🤝 **Mesh Agent Exchange Protocol（MAEP）**：如果你和伙伴各自运行多个 Agent，且希望它们互相通信，可以使用 MAEP。它是一个带信任状态与审计轨迹的 P2P 协议（见 [../maep.md](../maep.md)，WIP）。
- 🔒 **严肃的默认安全策略**：基于 profile 的凭据注入、Guard 脱敏、出站策略控制、带审计轨迹的异步审批（见 [../security.md](../security.md)）。
- 🧰 **实用的 Skills 系统**：可从 `file_state_dir/skills` 发现并注入 `SKILL.md`，支持简单的 on/off 控制（见 [../skills.md](../skills.md)）。
- 📚 **对新手友好**：这是一个以学习为导向的 Agent 项目；`docs/` 里有详细设计文档，也提供了 `--inspect-prompt`、`--inspect-request` 等实用调试工具。

<a id="quickstart"></a>
## 快速开始

### 第 1 步：安装

方案 A：从 GitHub Releases 下载预构建二进制（生产环境推荐）：

```bash
curl -fsSL -o /tmp/install-mistermorph.sh \
  https://raw.githubusercontent.com/quailyquaily/mistermorph/main/scripts/install-release.sh
bash /tmp/install-mistermorph.sh v0.1.0
```

安装脚本支持：

- `bash install-release.sh <version-tag>`
- `INSTALL_DIR=$HOME/.local/bin bash install-release.sh <version-tag>`

方案 B：使用 Go 从源码安装：

```bash
go install github.com/quailyquaily/mistermorph@latest
```

### 第 2 步：安装 Agent 运行所需文件与内置技能

```bash
mistermorph install
# 或
mistermorph install <dir>
```

`install` 命令会把必需文件和内置技能安装到 `~/.morph/skills/`（或你通过 `<dir>` 指定的目录）。

### 第 3 步：配置 API Key

打开配置文件 `~/.morph/config.yaml`，填入你的 LLM provider API key。以 OpenAI 为例：

```yaml
llm:
  provider: "openai"
  endpoint: "https://api.openai.com/v1"
  model: "gpt-5.2"
  api_key: "YOUR_OPENAI_API_KEY_HERE"
```

Mister Morph 也支持 Azure OpenAI、Anthropic Claude、AWS Bedrock 等（更多配置见 `../../assets/config/config.example.yaml`）。

### 第 4 步：首次运行

```bash
mistermorph run --task "Hello!"
```

<a id="supported-models"></a>
## 支持模型

> 模型支持情况可能因具体模型 ID、provider endpoint 能力和 tool-calling 行为而变化。

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

<a id="telegram-bot-mode"></a>
## Telegram 机器人模式

通过长轮询运行 Telegram 机器人，这样你就可以直接在 Telegram 里和 Agent 对话：

编辑 `~/.morph/config.yaml`，设置 Telegram bot token：

```yaml
telegram:
  bot_token: "YOUR_TELEGRAM_BOT_TOKEN_HERE"
  allowed_chat_ids: [] # 在这里加入允许的 chat id
```

```bash
mistermorph telegram --log-level info
```

说明：
- 使用 `/id` 获取当前 chat id，并把它加入 `allowed_chat_ids` 白名单。
- 在群聊中可用 `/ask <task>`。
- 在群聊里，回复机器人消息或提及 `@BotUsername` 也会触发响应。
- 你可以发送文件；文件会下载到 `file_cache_dir/telegram/`，Agent 可以处理它。Agent 也能通过 `telegram_send_file` 回传缓存文件，还可以通过 `telegram_send_voice` 发送位于 `file_cache_dir` 的本地语音文件。
- 每个 chat 会保留最近一次加载的 skill（sticky），后续消息不会“忘记” `SKILL.md`；可用 `/reset` 清除。
- 如果配置了 `telegram.aliases`，默认的 `telegram.group_trigger_mode=smart` 只会在消息看起来是直接称呼时触发 alias；smart 模式下 alias 命中还会经过 LLM 校验。
- `telegram.group_trigger_mode=talkative` 会让每条群消息都进入 addressing LLM 判定；通过 `telegram.addressing_confidence_threshold` 控制最低置信度，并在 `irrelevance` 高于 `telegram.addressing_irrelevance_threshold` 时拒绝触发。
- 可在 chat 中使用 `/reset` 清空对话历史。
- 默认支持多 chat 并发处理，但单个 chat 内按串行处理（配置项：`telegram.max_concurrency`）。

<a id="daemon-mode"></a>
## 守护进程模式

运行本地 HTTP 守护进程，按顺序（逐个）接收任务，这样你不需要每次任务都重启进程。

启动守护进程：

```bash
export MISTER_MORPH_SERVER_AUTH_TOKEN="change-me"
mistermorph serve --server-port 8787 --log-level info
```

提交任务：

```bash
mistermorph submit --server-url http://127.0.0.1:8787 --auth-token "$MISTER_MORPH_SERVER_AUTH_TOKEN" --wait \
  --task "Summarize this repo and write to ./summary.md"
```

<a id="embedding-to-other-projects"></a>
## 嵌入到其他项目

常见的两种集成方式：

- 作为 Go 库：见 `../../demo/embed-go/`。
- 作为 CLI 子进程：见 `../../demo/embed-cli/`。

<a id="built-in-tools"></a>
## 内置工具

Agent 可用的核心工具：

- `read_file`：读取本地文本文件。
- `write_file`：将文本文件写入 `file_cache_dir` 或 `file_state_dir`。
- `bash`：执行 shell 命令（默认禁用）。
- `url_fetch`：发起 HTTP 请求（可选 auth profile）。
- `web_search`：网页搜索（DuckDuckGo HTML）。
- `plan_create`：生成结构化计划。

仅在 Telegram 模式可用的工具：

- `telegram_send_file`：在 Telegram 发送文件。
- `telegram_send_voice`：在 Telegram 发送语音消息。
- `telegram_react`：在 Telegram 添加 emoji reaction。

详细工具文档请见 [../tools.md](../tools.md)。

<a id="skills"></a>
## Skills（技能）

`mistermorph` 可以在 `file_state_dir/skills` 下递归发现 skills，并将选中的 `SKILL.md` 内容注入 system prompt。

默认情况下，`run` 使用 `skills.mode=on`，会加载 `skills.load` 和可选的 `$SkillName` 引用（`skills.auto=true`）。

文档： [../skills.md](../skills.md)。

```bash
# 列出可用 skills
mistermorph skills list
# 在 run 命令中使用指定 skill
mistermorph run --task "..." --skills-mode on --skill skill-name
# 安装远程 skill
mistermorph skills install <remote-skill-url>
```

### Skills 的安全机制

1. 安装审计：安装远程 skill 时，Mister Morph 会先预览技能内容，并做基础安全审计（例如扫描脚本中的危险命令），再请求用户确认。
2. Auth profiles：skill 可以在 `auth_profiles` 字段声明依赖的认证配置。只有宿主机已配置对应 auth profile 的 skill 才会被 Agent 使用，从而避免意外泄漏密钥（见 `../../assets/skills/moltbook` 以及配置文件中的 `secrets` / `auth_profiles` 部分）。

<a id="security"></a>
## 安全性

推荐的 systemd 加固与密钥管理方式： [../security.md](../security.md)。

<a id="troubleshoots"></a>
## 故障排查

已知问题与规避建议： [../troubleshoots.md](../troubleshoots.md)。

<a id="debug"></a>
## 调试

### 日志

可通过参数 `--log-level` 设置日志级别与格式：

```bash
mistermorph run --log-level debug --task "..."
```

### 导出内部调试数据

可用 `--inspect-prompt` / `--inspect-request` 这两个参数导出内部状态，便于调试：

```bash
mistermorph run --inspect-prompt --inspect-request --task "..."
```

这些参数会把最终 system/user/tool prompt，以及完整 LLM 请求/响应 JSON，以纯文本形式输出到 `./dump` 目录。

<a id="configuration"></a>
## 配置

`mistermorph` 使用 Viper，因此你可以通过 flags、环境变量或配置文件进行配置。

- 配置文件：`--config /path/to/config.yaml`（支持 `.yaml/.yml/.json/.toml/.ini`）
- 环境变量前缀：`MISTER_MORPH_`
- 嵌套键：将 `.` 和 `-` 替换为 `_`（例如 `tools.bash.enabled` → `MISTER_MORPH_TOOLS_BASH_ENABLED=true`）

### CLI 参数

**全局（所有命令）**
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
- `--log-redact-key`（可重复）

**run**
- `--task`
- `--provider`
- `--endpoint`
- `--model`
- `--api-key`
- `--llm-request-timeout`
- `--interactive`
- `--skills-dir`（可重复）
- `--skill`（可重复）
- `--skills-auto`
- `--skills-mode`（`off|on`）
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
