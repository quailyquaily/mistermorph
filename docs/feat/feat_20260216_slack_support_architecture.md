---
date: 2026-02-16
title: Slack 支持架构评审与实施方案
status: draft
---

# Slack 支持架构评审与实施方案（MVP）

## 1) 架构 Review 结论（按严重级）

### P0-1: Slack 仅有类型预埋，缺少运行链路
- 现状：
  - `internal/channels/channels.go`、`internal/bus/message.go`、`internal/bus/conversation_key.go` 已有 `slack` 常量与 key builder。
  - `internal/bus/adapters/` 只有 `telegram` 和 `maep`。
  - `cmd/mistermorph/root.go` 没有 `slack` 子命令。
- 影响：
  - 当前无法接收 Slack 入站消息，也无法通过 bus 出站到 Slack。

### P0-2: 联系人发送路径仅支持 Telegram/MAEP
- 现状：
  - `contacts/service.go` 的 `resolveDecisionChannel(...)` 只会解析到 `telegram/maep`。
  - `internal/contactsruntime/sender.go` 的 delivery dispatch 只处理 `ChannelTelegram/ChannelMAEP`。
- 影响：
  - `contacts_send` 不可能路由到 Slack。

### P1-1: 事件扩展字段偏 Telegram 形态，不适合 Slack 标识
- 现状：
  - `internal/bus/message.go` 中 `MessageExtensions` 依赖 `FromUserID int64` 等 Telegram 结构。
  - Slack 的 `team_id/user_id/channel_id/thread_ts/event_id` 都是字符串语义。
- 影响：
  - Slack 身份与线程信息无法完整落总线，后续联系人观察、审计、提示词上下文会丢信息。

### P1-2: 历史上下文与运行时 prompt block 仍是 Telegram 专用
- 现状：
  - `internal/chathistory/types.go` 目前只定义了 `ChannelTelegram`。
  - `internal/promptprofile/prompt_blocks.go` 只有 `AppendTelegramRuntimeBlocks` 与 `AppendMAEPReplyPolicyBlock`。
- 影响：
  - Slack 无法复用结构化历史与渠道策略注入能力。

### P1-3: 联系人自动观察仅覆盖 Telegram/MAEP
- 现状：
  - `contacts/bus_observe.go` 只处理 `ChannelTelegram/ChannelMAEP`。
- 影响：
  - Slack 入站无法自动沉淀联系人画像与 reachability。

### P2-1: TODO 引用格式支持 Slack，但 chat_id 校验仍仅允许 tg
- 现状：
  - `internal/todo/ops.go` 的 `isValidReferenceID` 已接受 `slack:*`。
  - 同文件 `isValidTODOChatID` 仅允许 `tg:<int64>`。
- 影响：
  - 跨渠道上下文表达不一致，Slack 运行时无法正确记录 `chat_id` 元数据。

## 2) 设计目标与非目标

### 2.1 目标（MVP）
- 新增 `mistermorph slack` 长运行模式，支持消息收取、LLM 执行与回复发送。
- Slack 入站/出站统一经过 bus，不走旁路直接发送。
- 保持现有 Telegram/MAEP 路径行为不变（无回归）。
- `contacts_send` 能路由到 Slack。
- 保持与现有工具/guard/skills/prompt 组装机制兼容。

### 2.2 非目标（MVP 不做）
- 不做 Slack 文件上传/下载工具。
- 不做 Slack reaction 工具。
- 不做 Events API（公网 HTTP 入站）模式，先做 Socket Mode。
- 不做大规模 Telegram runtime 抽象重构（避免一次性高风险改动）。

## 3) 方案总览

### 3.1 传输模式选择：Socket Mode 优先

理由：
- 当前项目是 CLI 常驻进程模型，Socket Mode 不要求公网回调地址。
- 本地开发与私有部署更直接。
- 可在后续增加 Events API 作为可选入口，不影响 bus 与 adapter 分层。

### 3.2 统一标识规范（Slack）

- `conversation_key`: `slack:<team_id>:<channel_id>`
- `platform_message_id`: `<team_id>:<channel_id>:<message_ts>`
- `participant_key`: `<team_id>:<user_id>`
- `extensions.reply_to`: `thread_ts`（无 thread 则为空）
- `extensions.chat_type`: `im|mpim|channel|private_channel`

说明：
- `team_id` 放进 key，可避免多 workspace 混淆。
- `message_ts` 作为平台消息唯一键，参与 inbox 去重。

### 3.3 目标链路

```text
Slack Socket Mode
  -> cmd/mistermorph/slackcmd (事件消费)
  -> internal/bus/adapters/slack.InboundAdapter
  -> internal/bus.Inproc
  -> Slack worker (按 conversation_key 串行)
  -> agent.Run
  -> publishSlackBusOutbound(...)
  -> internal/bus/adapters/slack.DeliveryAdapter
  -> Slack chat.postMessage
```

## 4) 模块设计与改造清单

### 4.1 新增 Slack Bus Adapter

新增文件：
- `internal/bus/adapters/slack/inbound.go`
- `internal/bus/adapters/slack/inbound_test.go`
- `internal/bus/adapters/slack/delivery.go`
- `internal/bus/adapters/slack/delivery_test.go`

要点：
- 入站复用 `internal/bus/adapters.InboundFlow`（已有去重模板）。
- 出站实现 `Deliver(ctx, BusMessage)`，读取 `conversation_key` 与 envelope，调用 Slack 发送函数。

### 4.2 新增 Slack 运行命令

新增目录：
- `cmd/mistermorph/slackcmd/`

核心职责：
- 建立 Socket Mode 连接与事件循环。
- 过滤自身 bot 消息，避免自触发回环。
- 将有效入站消息发布到 bus。
- 复用 agent 执行链（工具注册、skills、promptprofile、guard）。
- 出站统一走 bus + slack delivery adapter。

CLI 接口（建议）：
- `mistermorph slack`
- `--slack-bot-token`
- `--slack-app-token`
- `--slack-allowed-team-id`（repeatable）
- `--slack-allowed-channel-id`（repeatable）
- `--slack-task-timeout`
- `--slack-max-concurrency`
- `--inspect-prompt`
- `--inspect-request`

### 4.3 扩展 Bus MessageExtensions（向后兼容）

建议在 `internal/bus/message.go` 的 `MessageExtensions` 增加可选字段：
- `TeamID string`
- `ChannelID string`
- `FromUserRef string`
- `ThreadTS string`
- `EventID string`

原则：
- 保留现有 Telegram 字段，不做破坏式替换。
- 新字段仅用于 Slack/后续渠道，旧路径不受影响。

### 4.4 Contacts 与路由扩展

建议改动：
- `contacts/types.go`
- `contacts/file_store.go`
- `contacts/service.go`
- `contacts/bus_observe.go`
- `internal/contactsruntime/sender.go`
- `tools/builtin/contacts_send.go`

建议新增 contact 字段：
- `slack_team_id`
- `slack_user_id`
- `slack_dm_channel_id`
- `slack_channel_ids`

路由规则（建议）：
- `decision.chat_id` 以 `slack:` 开头时直接路由 Slack。
- 否则若 contact 有可发送 Slack target（优先 `slack_dm_channel_id`）则路由 Slack。
- 仍保留 Telegram/MAEP 现有优先级与行为。

### 4.5 ChatHistory 与 PromptProfile 扩展

建议改动：
- `internal/chathistory/types.go` 增加 `ChannelSlack`。
- `internal/promptprofile/prompt_blocks.go` 新增 `AppendSlackRuntimeBlocks(...)`。
- `internal/promptprofile/prompts/slack_block.tmpl`（新模板）。

目标：
- Slack 运行时有独立策略块（线程回复、@mention、channel etiquette）。
- 历史结构继续复用 `ChatHistoryItem`，不再假设 Telegram-only。

### 4.6 TODO 上下文兼容修复

建议改动：
- `internal/todo/ops.go`
- `internal/todo/reference_llm.go`
- `tools/builtin/todo_update.go`

目标：
- `chat_id` 校验支持 `slack:*`（至少不拒绝）。
- `AddResolveContext` 增加字符串型渠道身份字段（保留原字段兼容）。

## 5) 分阶段落地计划

### Phase A（基础可运行）
- 新增 Slack inbound/delivery adapters + 单测。
- 新增 `mistermorph slack`（Socket Mode，文本消息往返）。
- bus 全链路跑通，支持线程回复。

验收：
- 在允许的 team/channel 内，发送文本可得到模型回复。
- 同一 `platform_message_id` 重放不会重复触发执行。

### Phase B（业务可用）
- `contacts_send` 支持 Slack 路由。
- `contacts.ObserveInboundBusMessage` 增加 Slack 观察分支。
- contacts markdown 模板与 docs 更新。

验收：
- Slack 入站可生成/更新联系人。
- `contacts_send` 可按 contact_id 正确发往 Slack。

### Phase C（体验完善）
- ChatHistory + PromptProfile Slack block。
- TODO chat_id 兼容修复。
- 补全 README/docs/bus/docs/tools 文档。

验收：
- Slack 运行时行为约束可通过 prompt block 生效。
- TODO 元数据可保留 Slack chat 标识。

## 6) 测试方案

单元测试：
- `internal/bus/adapters/slack/*_test.go`
- `contacts/service` 新增 Slack 路由 case
- `contacts/bus_observe` 新增 Slack case
- `internal/contactsruntime/sender_bus_test.go` 新增 Slack case
- `internal/todo/ops_test.go` 新增 `slack:` chat_id case

集成测试：
- `cmd/mistermorph/slackcmd` 使用 mock Slack API + mock Socket events。
- bus 级联验证：Slack inbound -> MAEP outbound（可复用现有 cross-channel 思路）。

回归测试：
- `go test ./internal/bus/... ./internal/bus/adapters/... ./contacts/... ./internal/contactsruntime/... ./cmd/mistermorph/telegramcmd ./cmd/mistermorph/maepcmd`

## 7) 风险与缓解

- 风险：Slack 重复事件导致重复回复。  
  缓解：严格使用 `platform_message_id` 走 inbox 去重。

- 风险：Bot 自身消息回流触发死循环。  
  缓解：在 slackcmd 入站层过滤 bot/self subtype。

- 风险：多 workspace channel id 冲突。  
  缓解：`conversation_key/platform_message_id/participant_key` 都纳入 `team_id`。

- 风险：一次性重构 Telegram runtime 导致回归。  
  缓解：MVP 不做大重构，先并行引入 Slack 命令与 adapter。

## 8) 决策状态

已确认（2026-02-16）：
1. MVP 只支持 Socket Mode。
2. Slack DM 发送策略与当前 Telegram 一致：不自动 `conversations.open`，必须已有可发送 target（如 `slack_dm_channel_id`）。
3. Slack 首版需要与 Telegram 一致的群聊触发分类能力（addressing 分类）。
4. `slack.auto_open_dm` 暂不实现（等价固定为 false）；后续如需支持再单独立项。

## 9) 建议再细化的实现级规格（已补充）

### 9.1 Slack App 权限与 API 依赖

MVP（Socket Mode + 文本收发）建议最小 scopes：
- `app_mentions:read`
- `channels:history`
- `groups:history`
- `im:history`
- `mpim:history`
- `chat:write`
- `reactions:write`（仅当后续 Slack react tool 落地时需要，MVP 可不启用）
- `users:read`（仅当需要补充用户名映射时启用）
- `users:read.email`（MVP 不需要）

MVP 依赖 API：
- Socket Mode events（WebSocket）
- `chat.postMessage`

非 MVP（暂不启用）：
- `conversations.open`（自动开 DM）

### 9.2 Slack 入站事件过滤矩阵

必须处理：
- `message`（普通消息）
- `app_mention`

必须忽略：
- `bot_message` subtype
- 来自本 bot user id 的消息
- `message_changed` / `message_deleted`（MVP 不回放编辑消息）
- 无 `text` 且无可处理内容的事件

建议规则：
- 私聊（`im`）：默认可触发。
- 群聊（`channel/private_channel/mpim`）：走 addressing 判定（与 Telegram 一致）。

### 9.3 配置键建议（对齐现有风格）

建议新增配置：

```yaml
slack:
  bot_token: ""
  app_token: ""
  allowed_team_ids: []
  allowed_channel_ids: []
  task_timeout: "0s"   # 0 表示继承全局 timeout
  max_concurrency: 3
  group_trigger_mode: "smart"   # strict|smart|talkative（与 telegram 对齐）
  addressing_confidence_threshold: 0.6
  addressing_interject_threshold: 0.6
  # auto_open_dm 不在当前范围内（固定 false）
```

### 9.4 Slack 出站失败与限流策略

`slack.DeliveryAdapter` 建议统一错误分类：
- 429：识别 `Retry-After`，按该值退避后重试（单次消息建议最多 3 次）。
- 5xx：指数退避重试（例如 300ms, 1s, 2s，上限 3 次）。
- 4xx（非 429）：直接失败，不重试。

与 bus/outbox 的关系：
- adapter 内重试只处理“短暂错误”。
- 超过重试上限后返回错误给 bus handler，由 outbox 记为 failed。

### 9.5 与 Telegram 对齐的群聊触发策略

Slack `group_trigger_mode` 行为定义建议直接复用 Telegram 语义：
- `strict`：仅显式触发（@mention / reply / command）才进入 agent run。
- `smart`：消息先经 addressing LLM，且 `addressed=true` 才执行。
- `talkative`：消息先经 addressing LLM，但不强制 `addressed=true`。

统一阈值：
- `confidence >= addressing_confidence_threshold`
- `interject > addressing_interject_threshold`

### 9.6 日志与安全要求

- 日志中不得输出 `slack.bot_token` 与 `slack.app_token`。
- 记录 Slack API 失败时仅输出：
  - HTTP status
  - Slack error code（如 `channel_not_found`）
  - correlation id / idempotency key
- 不记录原始 Authorization 头与完整响应体。

## 10) Phase A 交付定义（DOD）

满足以下全部条件即认为 Phase A 完成：
- 有 `mistermorph slack` 子命令，可稳定运行 Socket Mode 循环。
- Slack 入站事件可转为 bus inbound（带去重）。
- agent 输出通过 bus outbound -> Slack delivery adapter 发回 Slack。
- 群聊触发支持 `strict|smart|talkative`，且阈值配置可用。
- 新增单测：
  - `internal/bus/adapters/slack/inbound_test.go`
  - `internal/bus/adapters/slack/delivery_test.go`
  - `cmd/mistermorph/slackcmd` 关键路径测试（mock 事件）
- Telegram/MAEP 回归测试通过。

## 11) Telegram -> Slack 复用度评估（仅看 Phase A）

工程估算（不含 MAEP 改造）：
- 可复用总体约 `70%`
- 其中“基本直接复用”约 `45%`
- “小改后可复用”约 `25%`
- “必须新写”约 `30%`

### 11.1 基本直接复用（约 45%）
- Bus 运行与分发框架：
  - `internal/bus/inproc.go`
  - `internal/bus/bootstrap.go`
  - `internal/bus/topic.go`
  - `internal/bus/envelope.go`
- Agent 执行主链与运行时注入：
  - `agent/*`
  - `cmd/mistermorph/registry.go`
  - `internal/toolsutil/*`
  - `guard/*`
  - `skills/*`
- Structured history 注入模式（结构可直接复用）：
  - `internal/chathistory/types.go`
  - `internal/chathistory/render.go`

### 11.2 小改后可复用（约 25%）
- Telegram worker/bus wiring 的组织方式（迁移为 slackcmd）：
  - `cmd/mistermorph/telegramcmd/command.go`
- 群聊触发与 addressing 判定流程：
  - `cmd/mistermorph/telegramcmd/runtime_helpers.go`
  - `cmd/mistermorph/telegramcmd/addressing_prompts.go`
- inbound adapter 模板：
  - `internal/bus/adapters/inbound_flow.go`
  - `internal/bus/adapters/telegram/inbound.go`

### 11.3 必须新写（约 30%）
- Slack transport 与协议适配：
  - `cmd/mistermorph/slackcmd/*`（Socket Mode 事件循环）
  - `internal/bus/adapters/slack/inbound.go`
  - `internal/bus/adapters/slack/delivery.go`
- Slack 事件字段解析与过滤（team/channel/thread/subtype）
- Slack 发送 API 调用与 rate-limit 处理（`chat.postMessage` + 429/backoff）

## 12) 新增与扩展的结构/Type 清单（实现契约）

> 状态说明：以下均为实现前约定，当前仓库尚未落代码。

### 12.1 新增 Type（Planned）

1. `internal/bus/adapters/slack/inbound.go`

```go
type InboundAdapterOptions struct {
  Bus   *busruntime.Inproc
  Store baseadapters.InboundStore
  Now   func() time.Time
}

type InboundMessage struct {
  TeamID       string
  ChannelID    string
  ChatType     string // im|mpim|channel|private_channel
  MessageTS    string // e.g. 1739500000.123456
  ThreadTS     string // optional
  UserID       string
  Username     string
  DisplayName  string
  Text         string
  MentionUsers []string
  EventID      string // optional
}

type InboundAdapter struct {
  flow  *baseadapters.InboundFlow
  nowFn func() time.Time
}
```

2. `internal/bus/adapters/slack/delivery.go`

```go
type SendTextFunc func(ctx context.Context, target any, text string, opts SendTextOptions) error

type SendTextOptions struct {
  ThreadTS string
}

type DeliveryAdapterOptions struct {
  SendText SendTextFunc
}

type DeliveryAdapter struct {
  sendText SendTextFunc
}
```

3. `cmd/mistermorph/slackcmd/*`

```go
type slackJob struct {
  TeamID       string
  ChannelID    string
  ChatType     string
  MessageTS    string
  ThreadTS     string
  UserID       string
  Username     string
  DisplayName  string
  Text         string
  Version      uint64
  MentionUsers []string
}

type slackChatWorker struct {
  Jobs    chan slackJob
  Version uint64
}
```

4. `cmd/mistermorph/slackcmd/api_types.go`（建议新文件）

```go
type slackEventEnvelope struct {
  EnvelopeID string          `json:"envelope_id"`
  Type       string          `json:"type"`
  Payload    json.RawMessage `json:"payload"`
}

type slackMessageEvent struct {
  Type      string `json:"type"`
  Subtype   string `json:"subtype,omitempty"`
  Team      string `json:"team,omitempty"`
  Channel   string `json:"channel"`
  ChannelType string `json:"channel_type,omitempty"`
  User      string `json:"user,omitempty"`
  Text      string `json:"text,omitempty"`
  Ts        string `json:"ts"`
  ThreadTs  string `json:"thread_ts,omitempty"`
  BotID     string `json:"bot_id,omitempty"`
}
```

### 12.2 扩展 Type（Planned）

1. 扩展 `internal/bus/message.go` `MessageExtensions`

```go
type MessageExtensions struct {
  // existing fields...

  TeamID      string `json:"team_id,omitempty"`
  ChannelID   string `json:"channel_id,omitempty"`
  FromUserRef string `json:"from_user_ref,omitempty"` // e.g. U12345
  ThreadTS    string `json:"thread_ts,omitempty"`
  EventID     string `json:"event_id,omitempty"`
}
```

2. 扩展 `contacts/types.go` `Contact`

```go
type Contact struct {
  // existing fields...

  SlackTeamID     string   `json:"slack_team_id,omitempty"`
  SlackUserID     string   `json:"slack_user_id,omitempty"`
  SlackDMChannelID string  `json:"slack_dm_channel_id,omitempty"`
  SlackChannelIDs []string `json:"slack_channel_ids,omitempty"`
}
```

3. 扩展 `contacts/types.go` channel 常量

```go
const (
  ChannelTelegram = channels.Telegram
  ChannelMAEP     = channels.MAEP
  ChannelSlack    = channels.Slack
)
```

4. 扩展 `internal/chathistory/types.go` channel 常量（结构本体复用）

```go
const (
  ChannelTelegram = "telegram"
  ChannelSlack    = "slack"
)
```

5. 扩展 `internal/todo/reference_llm.go` `AddResolveContext`

```go
type AddResolveContext struct {
  // existing fields...

  SpeakerRefID    string // e.g. tg:123 / slack:T123:U123
  ConversationRef string // e.g. tg:-1001 / slack:T123:C123
}
```

6. 扩展 `internal/contactsruntime/sender.go` `SenderOptions`（Phase B）

```go
type SenderOptions struct {
  // existing fields...

  SlackBotToken string
  SlackBaseURL  string
}
```

### 12.3 新增配置结构（Planned）

对应 `assets/config/config.example.yaml` 建议新增：

```yaml
slack:
  bot_token: ""
  app_token: ""
  allowed_team_ids: []
  allowed_channel_ids: []
  task_timeout: "0s"
  max_concurrency: 3
  group_trigger_mode: "smart"
  addressing_confidence_threshold: 0.6
  addressing_interject_threshold: 0.6
```

## 13) Slack Memory 命名与用户记录规范（Planned）

目标：复用现有 `memory` 目录与 frontmatter 结构，不新增新的 memory 存储格式。

### 13.1 SessionID 规范（决定 short-term 文件名）

沿用 `memory` 当前行为：short-term 文件名来自 `session_id` 的 sanitize 结果。

建议规则：
- DM：`slack:<team_id>:<dm_channel_id>`
- 频道非线程：`slack:<team_id>:<channel_id>`
- 线程：`slack:<team_id>:<channel_id>:<thread_ts>`

示例：
- `session_id = slack:T123:D456`
  - 文件名：`slack_T123_D456.md`
- `session_id = slack:T123:C789:1739500000.123456`
  - 文件名：`slack_T123_C789_1739500000_123456.md`

### 13.2 Memory 目录结构（保持不变）

```text
<file_state_dir>/<memory.dir_name>/
├── index.md
└── YYYY-MM-DD/
    └── <sanitized_session_id>.md
```

### 13.3 用户记录字段规范

复用已有 frontmatter 字段：
- `contact_id`: 记录结构化用户 ID，格式 `slack:<team_id>:<user_id>`
- `contact_nickname`: 记录用户展示名（与 `contact_id` 顺序对齐）

建议在摘要正文中使用可解析的人名引用格式：
- `[DisplayName](slack:<team_id>:<user_id>)`

### 13.4 用户采集规则（写入 memory 前）

1. 必须包含当前消息发言人（`event.user`）。
2. 解析消息体中的 `<@U...>` mention，转换为 `slack:<team_id>:<user_id>`。
3. 对 `contact_id` 去重并限制上限（建议最多 12 个）。
4. `contact_nickname` 与 `contact_id` 按索引对齐，不可错位。

### 13.5 与现有 Telegram 路径一致性

- Telegram 当前使用 `session_id=tg:<chat_id>`；Slack 采用 `slack:<team_id>:<channel_id>[:thread_ts]`，语义一致。
- 两者都复用 `memory.WriteMeta{SessionID, ContactIDs, ContactNicknames}`，不新增 Slack 专用 memory 文件格式。

## 14) Phase A 实施状态（2026-02-16）

### 14.1 已完成

1. Slack bus adapters（入站/出站）已落代码并有单测：
- `internal/bus/adapters/slack/inbound.go`
- `internal/bus/adapters/slack/delivery.go`
- `internal/bus/adapters/slack/inbound_test.go`
- `internal/bus/adapters/slack/delivery_test.go`

2. `MessageExtensions` 已扩展 Slack 字段并完成校验：
- `team_id`
- `channel_id`
- `from_user_ref`
- `thread_ts`
- `event_id`

3. `mistermorph slack` 子命令（Socket Mode）已落地：
- 新增 `cmd/mistermorph/slackcmd/`：
  - `command.go`（编排层）
  - `socket_events.go`（Socket 事件读取/解析）
  - `trigger.go`（群聊触发决策）
  - `runtime_task.go`（任务执行与出站）
  - `deps.go`
  - `slack_api.go`
  - `command_test.go`
- 能力范围（Phase A）：
  - Socket Mode 连接与自动重连
  - envelope ack
  - Slack 事件过滤（忽略 bot/self/subtype）
  - 入站 -> bus -> worker -> agent -> bus 出站 -> `chat.postMessage`
  - 群聊触发模式：`strict|smart|talkative`
  - thread 回复（通过 `thread_ts`）

4. root/defaults/config 已接线：
- `cmd/mistermorph/root.go` 已注册 `slack` 子命令
- `cmd/mistermorph/defaults.go` 已加入 `slack.*` 默认项
- `assets/config/config.example.yaml` 已加入 `slack` 配置示例

5. chathistory 渠道常量已加入 Slack：
- `internal/chathistory/types.go` 增加 `ChannelSlack`

6. 触发决策核心已抽为共享层，并接入 Telegram/Slack：
- 新增 `internal/grouptrigger/decision.go`
- 新增 `internal/grouptrigger/decision_test.go`
- Telegram 触发逻辑拆分：
  - `cmd/mistermorph/telegramcmd/trigger.go`
  - `cmd/mistermorph/telegramcmd/trigger_addressing.go`

7. Phase B 首批能力已完成：
- `contacts_send` 路由已支持 Slack（`chat_id=slack:<team_id>:<channel_id>`，以及 contact reachability 自动选路）
- `contacts` 领域模型已扩展 Slack reachability 字段：
  - `slack_team_id`
  - `slack_user_id`
  - `slack_dm_channel_id`
  - `slack_channel_ids`
- `contacts.ObserveInboundBusMessage` 已增加 Slack 观察分支，并接入 `slackcmd` 入站处理
- `internal/contactsruntime/sender.go` 已接入 Slack delivery adapter（`chat.postMessage`）

### 14.2 暂未纳入（按原计划属于后续阶段）

- Slack memory 落盘实现（Phase C）
- TODO 的 Slack ref 扩展字段重构（当前仅保持兼容）
- Slack runtime prompt block（Phase C）

### 14.3 验证结果

- 已执行：`go test ./...`
- 结果：通过（无回归）
