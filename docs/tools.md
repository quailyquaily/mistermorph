# Tools Reference

本文档描述当前代码中的内置与运行时注入 tools 参数（基于 `tools/builtin/*.go`、`cmd/mistermorph/telegramcmd/*.go` 与注册逻辑）。

## 注册与可用性

- 默认注册（由 `cmd/mistermorph/registry.go` 控制）
  - `read_file`
  - `write_file`
  - `bash`
  - `url_fetch`
  - `web_search`
  - `todo_update`
  - `contacts_send`
- 条件注册
  - `plan_create`（在 `run` / `telegram` / `daemon serve` 模式通过 `internal/toolsutil.RegisterPlanTool` 注入，可由 `tools.plan_create.enabled` 关闭）
  - `telegram_send_voice`（仅 `mistermorph telegram` 运行时注入）
  - `telegram_send_file`（仅 `mistermorph telegram` 运行时注入）
  - `telegram_react`（仅 `mistermorph telegram` 运行时注入）

## `read_file`

用途：读取本地文本文件内容（超长会截断）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `path` | `string` | 是 | 无 | 文件路径。支持 `file_cache_dir/<path>` 与 `file_state_dir/<path>` 别名。 |

约束：

- 会受 `tools.read_file.deny_paths` 拦截。
- 别名必须带相对文件路径，不能只传 `file_cache_dir` 或 `file_state_dir`。

## `write_file`

用途：写入本地文件（覆盖或追加）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `path` | `string` | 是 | 无 | 目标路径。相对路径默认写到 `file_cache_dir`。支持 `file_state_dir/<path>`。 |
| `content` | `string` | 是 | 无 | 要写入的文本内容。 |
| `mode` | `string` | 否 | `overwrite` | `overwrite` 或 `append`。 |

约束：

- 会默认创建目标父目录。
- 仅允许写入 `file_cache_dir` / `file_state_dir` 范围。
- 内容大小受 `tools.write_file.max_bytes` 限制。

## `bash`

用途：执行本地 `bash` 命令。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `cmd` | `string` | 是 | 无 | 要执行的 bash 命令。支持 `file_cache_dir/...` 与 `file_state_dir/...` 别名。 |
| `cwd` | `string` | 否 | 当前目录 | 命令执行目录。支持 `file_cache_dir/...` 与 `file_state_dir/...` 别名。 |
| `timeout_seconds` | `number` | 否 | `tools.bash.timeout` | 超时秒数覆盖值。 |

约束：

- 可被 `tools.bash.enabled` 关闭。
- 受 `tools.bash.deny_paths` 与内部 deny token 规则约束。

## `url_fetch`

用途：发起 HTTP(S) 请求并返回响应（可下载到文件）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `url` | `string` | 是 | 无 | 请求地址，仅支持 `http/https`。 |
| `method` | `string` | 否 | `GET` | `GET` / `POST` / `PUT` / `PATCH` / `DELETE`。 |
| `auth_profile` | `string` | 否 | 无 | 认证配置 ID（启用 secrets 后可用）。 |
| `headers` | `object<string,string>` | 否 | 无 | 自定义请求头（有 allowlist/denylist）。 |
| `body` | `string|object|array|number|boolean|null` | 否 | 无 | 请求体（仅 `POST/PUT/PATCH`）。 |
| `download_path` | `string` | 否 | 无 | 将响应体保存到缓存目录路径。 |
| `timeout_seconds` | `number` | 否 | `tools.url_fetch.timeout` | 超时秒数覆盖值。 |
| `max_bytes` | `integer` | 否 | `tools.url_fetch.max_bytes` 或下载上限 | 最大读取字节数。 |

约束：

- `download_path` 启用时会默认创建目标父目录。
- `download_path` 启用时返回下载元数据，不内联大响应。
- `headers` 存在安全限制（如 `Authorization`、`Cookie` 等禁止直接传入）。
- 会受 guard 网络策略限制。

## `web_search`

用途：网页搜索并返回结构化结果（当前实现基于 DuckDuckGo HTML）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `q` | `string` | 是 | 无 | 搜索关键词。 |
| `max_results` | `integer` | 否 | `tools.web_search.max_results` | 返回结果上限（代码侧最大 20）。 |

## `todo_update`

用途：维护 `file_state_dir` 下的 `TODO.md` / `TODO.DONE.md`，支持新增与完成事项。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `action` | `string` | 是 | 无 | `add` 或 `complete`。 |
| `content` | `string` | 是 | 无 | `add` 时为条目文本；`complete` 时为匹配查询。 |
| `people` | `array<string>` | 否（`add` 时必填） | 无 | 提及人物列表（通常包含说话者、被称呼者、以及其他提及对象）。 |
| `chat_id` | `string` | 否 | 空 | 任务上下文聊天 ID（例如 `tg:-1001234567890`）。写入 WIP 条目的 `ChatID:` 元字段。 |

返回：

- 成功时返回 `UpdateResult` JSON，关键字段：
  - `ok`：是否成功（布尔）。
  - `action`：实际执行动作（`add` / `complete`）。
  - `updated_counts`：`{open_count, done_count}`。
  - `changed`：`{wip_added, wip_removed, done_added}`。
  - `entry`：本次主变更条目（`created_at` / `done_at` / `content`）。
  - `warnings`：可选警告数组（例如 LLM 改写提示）。

约束：

- 受 `tools.todo_update.enabled` 开关控制。
- 依赖 LLM 客户端与模型；未绑定会报错。
- `add` 采用“参数抽取 + LLM 插入”流程：工具参数直接提供 `people`，然后由 LLM 结合 `content`、原始用户输入与运行时上下文插入 `名称 (ref_id)`。
- `chat_id` 当前仅接受 `tg:<chat-id>`（正负 int64，且不能为 0）。
- `add` 仅接受可引用 ID：`tg:<int64>`、`tg:@<username>`、`maep:<peer_id>`、`slack:<channel_id>`、`discord:<channel_id>`。
- `add` 中的引用 ID 必须存在于联系人快照的 `reachable_ids`。
- 若 `add` 中部分人物无法映射可引用 ID，工具不会中断，而是回退为“原样写入 content”，并在 `warnings` 中附加 `reference_unresolved_write_raw`。
- `complete` 仅走 LLM 语义匹配（无程序兜底）；歧义会直接报错。

错误（字符串匹配）：

| 错误字符串（包含） | 触发场景 |
|---|---|
| `todo_update tool is disabled` | 工具被禁用。 |
| `action is required` | 缺少 `action`。 |
| `content is required` | 缺少 `content` 或为空。 |
| `invalid action:` | `action` 不是 `add/complete`。 |
| `todo_update unavailable (missing llm client)` | 未注入 LLM client。 |
| `todo_update unavailable (missing llm model)` | 未配置模型。 |
| `invalid reference id:` | 文本里存在非法 `(...)` 引用。 |
| `missing_reference_id` | 人物提及无法唯一解析为可引用 ID。 |
| `reference id is not reachable:` | 引用 ID 不在联系人可达集合。 |
| `no matching todo item in TODO.md` | `complete` 未命中可完成条目。 |
| `ambiguous todo item match` | `complete` 命中多个候选。 |
| `people is required for add action` | `add` 未提供 `people` 参数。 |
| `people must be an array of strings` | `people` 不是字符串数组。 |
| `invalid reference_resolve response` | 引用插入 LLM 返回非法 JSON。 |
| `invalid semantic_match response` | 语义匹配 LLM 返回非法 JSON/结构。 |
| `invalid semantic_dedup response` | 语义去重 LLM 返回非法 JSON/结构。 |

注：`missing_reference_id` 在当前实现中通常由内部 LLM 解析阶段触发并被工具降级处理为原样写入；若上游直接消费该错误仍可按该字符串识别。

## `contacts_send`

用途：向单个联系人发送一条消息（自动路由 MAEP/Telegram）。

联系人资料维护说明：

- 读取联系人请用 `read_file` 读取 `file_state_dir/contacts/ACTIVE.md` 与 `file_state_dir/contacts/INACTIVE.md`。
- 更新联系人请用 `write_file` 直接编辑上述文件（遵循模板中的 YAML profile 结构）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `contact_id` | `string` | 是 | 无 | 目标联系人 ID。 |
| `chat_id` | `string` | 否 | 空 | 可选 Telegram chat 提示（例如 `tg:-1001234567890`）。 |
| `content_type` | `string` | 否 | `application/json` | 负载类型，必须是 envelope JSON 类型。 |
| `message_text` | `string` | 条件必填 | 无 | 文本内容；工具会自动封装为 envelope。 |
| `message_base64` | `string` | 条件必填 | 无 | base64url 编码的 envelope JSON。 |
| `session_id` | `string` | 否 | 空 | 会话 ID（UUIDv7）。`contacts_send` 固定发送 `chat.message`。 |
| `reply_to` | `string` | 否 | 空 | 可选，引用上一条消息 `message_id`。 |

约束：

- `contacts_send` 的发送 topic 固定为 `chat.message`（调用方不再传 `topic`）。
- 若传入 `chat_id`：
  - 仅当该值命中联系人的 `tg_private_chat_id` 或 `tg_group_chat_ids` 时使用该目标发送；
  - 否则回退到该联系人的 `tg_private_chat_id`；
  - 若仍不可用，则返回错误。
- `message_text` 与 `message_base64` 至少提供一个。
- `content_type` 默认 `application/json`，且必须是 `application/json`（可带参数，如 `application/json; charset=utf-8`）。
- 若提供 `message_base64`，其解码结果必须是 envelope JSON，并包含 `message_id` / `text` / `sent_at(RFC3339)` / `session_id(UUIDv7)`。
- 人类联系人发送默认允许；是否可送达仍取决于联系人资料中的可发送目标（私聊/群聊 chat_id）。

## `plan_create`

用途：生成执行计划 JSON。通常由系统在复杂任务时调用。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `task` | `string` | 是 | 无 | 待规划任务描述。 |
| `max_steps` | `integer` | 否 | 配置默认（通常 6） | 最大步骤数。 |
| `style` | `string` | 否 | 空 | 计划风格提示，如 `terse`。 |
| `model` | `string` | 否 | 当前默认模型 | 计划生成模型覆盖。 |

## `telegram_send_file`

用途：向当前 Telegram chat 发送本地缓存文件（document）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `path` | `string` | 是 | 无 | 本地文件路径。支持绝对路径，或 `file_cache_dir` 下相对路径。 |
| `filename` | `string` | 否 | `path` 的 basename | 发送给 Telegram 时展示的文件名。 |
| `caption` | `string` | 否 | 空 | 可选文件说明。 |

约束：

- 仅在 Telegram 模式可用。
- `path` 支持 `file_cache_dir/<path>` 别名写法。
- 仅允许发送 `file_cache_dir` 范围内文件；目录会报错。
- 文件大小受工具上限限制（当前默认 20 MiB）。

## `telegram_send_voice`

用途：发送 Telegram 语音消息（本地语音文件或本地 TTS 合成）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `chat_id` | `integer` | 否 | 当前上下文 chat | 目标 Telegram chat_id。无活动 chat 上下文时必填。 |
| `path` | `string` | 否 | 空 | 本地语音文件路径（建议 `.ogg`/Opus）。支持绝对路径，或 `file_cache_dir` 下相对路径。 |
| `text` | `string` | 否 | 空 | 当 `path` 为空时，用于本地 TTS 合成语音。 |
| `lang` | `string` | 否 | 自动检测 | TTS 语言标签（BCP-47，如 `en-US`、`zh-CN`）。 |
| `filename` | `string` | 否 | `path` 的 basename | 发送给 Telegram 时展示的文件名。 |
| `caption` | `string` | 否 | 空 | 可选说明；当 `path` 与 `text` 都为空时会作为 TTS 文本兜底。 |

约束：

- 仅在 Telegram 模式可用。
- 优先使用 `path`：有 `path` 时直接发送文件；无 `path` 时使用 `text`（为空则回退到 `caption`）做本地 TTS 合成。
- 本地文件仅允许在 `file_cache_dir` 范围内，且受大小上限限制（当前默认 20 MiB）。
- TTS 依赖本地语音引擎（`pico2wave` / `espeak-ng` / `espeak` / `flite`）和音频转换器（`ffmpeg` 或 `opusenc`）。

## `telegram_react`

用途：向 Telegram 消息添加 emoji reaction。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `chat_id` | `integer` | 否 | 当前上下文 chat | 目标 Telegram chat_id。 |
| `message_id` | `integer` | 否 | 触发消息 ID | 要添加 reaction 的消息 ID。 |
| `emoji` | `string` | 是 | 无 | reaction emoji。 |
| `is_big` | `boolean` | 否 | 空 | 是否使用 Telegram 大号 reaction。 |

约束：

- 仅在 Telegram 模式可用。
- 该工具在 Telegram 模式可用，且需存在 `message_id` 上下文（或显式传入）。

## 备注

- 参数实际校验以代码为准：`tools/builtin/*.go` 与 `cmd/mistermorph/telegramcmd/*.go`。
- 若 tool 被配置禁用，会返回 `... tool is disabled` 错误。
