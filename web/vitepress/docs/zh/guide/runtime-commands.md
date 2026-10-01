---
title: 命令
description: Chat、Console 和其他 Channels 支持的命令。
---

# 命令

命令是在交互式 chat、Console task 或通道 runtime 里发送的以 `/` slash 符号开头的命令。

> 在 Slack 中，由于 `/` 会触发 Slack 自己的命令，所以需要在 `/` 前面加一个空格。例如 ` /models`。
>
> Slack 群聊里，命令需要明确提到 bot。Telegram 群聊可以使用普通 bot command，例如 `/models@BotName`。
>
> Mixin 群聊里，需要在命令前提到 Bot 的 Mixin ID，例如 `@7000123456 /models`。
>
> Discord 上，这些命令也注册成了斜杠命令。在服务器里手动输入命令时，需要先 @提及 bot，例如 `@Morph /models`。

## 通用命令

这些命令在 CLI chat、Console Web、Telegram、Slack、LINE、Lark、Mixin Messenger、Discord、微信和 WhatsApp 中可用。

| 命令 | 作用 |
|---|---|
| `/help` | 列出当前可用的运行时命令。 |
| `/stop` | 停止当前对话里正在运行的任务。 |
| `/models` | 查看当前模型。 |
| `/think <task>` | 使用 `think` LLM route 运行该任务。 |
| `/skills` | 显示当前 skills。 |
| `/ctx` | 查看当前对话的上下文窗口占用。 |
| `/ctx compact` | 立即把较早的对话上下文压缩为 checkpoint。 |
| `/workspace` | 查看当前 workspace 目录。 |

`/stop` 只作用于同一个 runtime、同一个 conversation、topic 或 thread 的当前任务。没有正在运行的任务时返回 `🤔`。停止请求被接受时返回 `👌`。

任务运行中发送普通非命令消息时，这条消息会作为 steer 输入进入同一个任务，而不是创建新任务。steer 被接受时返回 `👌`。如果任务存在但已经不能接收 steer，返回 `😵‍💫`。

`/ctx` 不调用 LLM。如果当前对话还没有记录过 agent 运行用量，会显示暂无上下文用量记录。

`/ctx compact` 不检查自动压缩阈值，只发起一次 checkpoint LLM 请求，不进入正常 agent 主循环。命令和成功确认不会写入对话历史。上下文压缩被禁用或没有可安全压缩的历史前缀时，命令返回错误。

对于 `/workspace`，支持如下参数：

| 命令 | 作用 |
|---|---|
| `/workspace` | 无参数，查看当前 workspace 目录。 |
| `/workspace attach <dir>` | 绑定或替换 workspace 目录。 |
| `/workspace detach` | 解绑当前 workspace。 |

对于 `/models`，支持如下参数：

| 命令 | 作用 |
|---|---|
| `/models` | 查看当前模型。 |
| `/models list` | 列出已配置的模型 profile。 |
| `/models set <profile_name>` | 切换当前模型。 |
| `/models reset` | 重置为自动模型选择。 |

对于 `/think`，任务内容写在命令后面：

| 命令 | 作用 |
|---|---|
| `/think <task>` | 去掉命令前缀后，使用 `llm.routes.think`，并为本次任务临时应用 `reasoning_effort=xhigh`。 |

## CLI Chat 特有的命令

这些命令只在 `mistermorph chat` 中可用。

| 命令 | 作用 |
|---|---|
| `/exit` | 退出 chat session。 |
| `/quit` | 退出 chat session。 |
| `/reset` | 清空当前对话历史。 |
| `/init` | 为当前项目生成 `AGENTS.md`。 |
| `/update` | 重新生成 `AGENTS.md`，并覆盖已有文件。 |

## Telegram 特有的命令

这些命令只在 Telegram 中可用。

| 命令 | 作用 |
|---|---|
| `/id` | 显示当前 Telegram chat id 和 chat type。 |
| `/reset` | 清空该 chat 的聊天历史、sticky skills、已知 mention 和 init 状态。 |

## Mixin Messenger 特有的命令

| 命令 | 作用 |
|---|---|
| `/id` | 显示当前 Mixin conversation UUID 和类型。 |
| `/reset` | 清空 conversation 历史、sticky skills 和 checkpoint 状态。 |

## Discord 特有的命令

| 命令 | 作用 |
|---|---|
| `/id` | 显示当前 chat id（`discord:<channel_id>`）、服务器 ID、会话类型和你的用户引用。 |
| `/reset` | 清空会话历史、sticky skills 和 checkpoint 状态。 |
| `/approve <id>`、`/deny <id>` | 处理待审批请求；审批消息里也有按钮。 |

## 微信和 WhatsApp

| 命令 | 作用 |
|---|---|
| `/id` | 显示 chat id（`wechat:<user_id>` 或 `whatsapp:<user_id>`）、你的用户引用，以及 bot 或 agent 账号。 |
| `/approve <id>`、`/deny <id>` | 处理待审批请求。 |
