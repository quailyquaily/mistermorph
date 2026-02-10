# Tools Reference

本文档描述当前代码中的内置 tools 参数（基于 `tools/builtin/*.go` 与注册逻辑）。

## 注册与可用性

- 默认注册（由 `cmd/mistermorph/registry.go` 控制）
  - `echo`
  - `read_file`
  - `write_file`
  - `bash`
  - `url_fetch`
  - `web_search`
  - `memory_recently`
  - `todo_update`
  - `todo_list`
  - `contacts_upsert`
  - `contacts_list`
  - `contacts_candidate_rank`
  - `contacts_send`
- 条件注册
  - `plan_create`（在 `run` / `telegram` / `daemon serve` 模式通过 `internal/toolsutil.RegisterPlanTool` 注入）

## `echo`

用途：回显字符串，常用于调试。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `value` | `string` | 是 | 无 | 要回显的内容。 |

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
| `cmd` | `string` | 是 | 无 | 要执行的 bash 命令。 |
| `cwd` | `string` | 否 | 当前目录 | 命令执行目录。 |
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

## `memory_recently`

用途：读取最近短期记忆，返回摘要与元信息。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `days` | `integer` | 否 | `3` | 时间窗口（天）。 |
| `limit` | `integer` | 否 | `tools.memory.recently.max_items` | 返回条数上限。 |
| `include_body` | `boolean` | 否 | `false` | 是否附带解析后的 body。 |

## `todo_update`

用途：维护 `file_state_dir` 下的 `TODO.WIP.md` / `TODO.DONE.md`，支持新增与完成事项。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `action` | `string` | 是 | 无 | `add` 或 `complete`。 |
| `content` | `string` | 是 | 无 | `add` 时为条目文本；`complete` 时为匹配查询。 |
| `people` | `array<string>` | 否（`add` 时必填） | 无 | 提及人物列表（通常包含说话者、被称呼者、以及其他提及对象）。 |

返回：

- 成功时返回 `UpdateResult` JSON，关键字段：
  - `ok`：是否成功（布尔）。
  - `action`：实际执行动作（`add` / `complete`）。
  - `updated_counts`：`{open_count, done_count}`。
  - `changed`：`{wip_added, wip_removed, done_added}`。
  - `entry`：本次主变更条目（`created_at` / `done_at` / `content`）。
  - `warnings`：可选警告数组（例如 LLM 改写提示）。

约束：

- 受 `tools.todo.enabled` 开关控制。
- 依赖 LLM 客户端与模型；未绑定会报错。
- `add` 采用“参数抽取 + LLM 插入”流程：工具参数直接提供 `people`，然后由 LLM 结合 `content`、原始用户输入与运行时上下文插入 `名称 (ref_id)`。
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
| `no matching todo item in TODO.WIP.md` | `complete` 未命中可完成条目。 |
| `ambiguous todo item match` | `complete` 命中多个候选。 |
| `people is required for add action` | `add` 未提供 `people` 参数。 |
| `people must be an array of strings` | `people` 不是字符串数组。 |
| `invalid reference_resolve response` | 引用插入 LLM 返回非法 JSON。 |
| `invalid semantic_match response` | 语义匹配 LLM 返回非法 JSON/结构。 |
| `invalid semantic_dedup response` | 语义去重 LLM 返回非法 JSON/结构。 |

注：`missing_reference_id` 在当前实现中通常由内部 LLM 解析阶段触发并被工具降级处理为原样写入；若上游直接消费该错误仍可按该字符串识别。

## `todo_list`

用途：读取当前 TODO 条目，支持 `wip/done/both` 视图。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `scope` | `string` | 否 | `wip` | `wip` / `done` / `both`。 |

返回：

- 成功时返回 `ListResult` JSON，关键字段：
  - `scope`、`open_count`、`done_count`。
  - `wip_items` / `done_items`（按文件顺序返回，首条优先）。
  - `wip_path` / `done_path`。
  - `generated_at`。

错误（字符串匹配）：

| 错误字符串（包含） | 触发场景 |
|---|---|
| `todo_list tool is disabled` | 工具被禁用。 |
| `todo paths are not configured` | TODO 文件路径缺失。 |
| `invalid scope:` | `scope` 不是 `wip/done/both`。 |

## `contacts_upsert`

用途：创建或更新单个联系人画像（支持部分字段更新，未提供字段默认保留原值）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `contact_id` | `string` | 条件必填 | 无 | 联系人稳定 ID。更新时建议提供。 |
| `kind` | `string` | 否 | 保留旧值或存储层默认 | `agent` / `human`。 |
| `status` | `string` | 否 | `active` | `active` / `inactive`。 |
| `contact_nickname` | `string` | 否 | 空 | 联系人昵称。 |
| `persona_brief` | `string` | 否 | 空 | 联系人互动风格摘要。 |
| `persona_traits` | `object<string,number>` | 否 | 空 | 人格特征权重映射。 |
| `pronouns` | `string` | 否 | 空 | 代词信息（如 `she/her`、`they/them`）。 |
| `timezone` | `string` | 否 | 空 | IANA 时区（如 `Asia/Shanghai`、`America/New_York`）。 |
| `preference_context` | `string` | 否 | 空 | 长文本偏好/上下文备注。 |
| `subject_id` | `string` | 条件必填 | 空 | 人类联系人的主体 ID。 |
| `understanding_depth` | `number` | 否 | 继承旧值或 `30` | 认知深度，范围 `[0,100]`。 |
| `topic_weights` | `object<string,number>` | 否 | 空 | topic 偏好权重映射。 |
| `reciprocity_norm` | `number` | 否 | 继承旧值或 `0.5` | 互惠分，范围 `[0,1]`。 |

约束：

- `contact_id` / `subject_id` 至少提供一个。
- 当 `contact_id` 缺失时，服务会尝试由 `subject_id` 推导联系人 ID。
- `kind` 仅支持 `agent|human`。
- `status` 仅支持 `active|inactive`。
- `timezone` 仅接受合法 IANA 时区；非法值会被规范化为“空”。
- 数值参数会在存储层被归一化（例如深度裁剪到 `[0,100]`、分值裁剪到 `[0,1]`）。

## `contacts_list`

用途：列出联系人信息。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `status` | `string` | 否 | `all` | `all` / `active` / `inactive`。 |
| `limit` | `integer` | 否 | `0` | 返回条数上限，`<=0` 表示不限制。 |

返回：

- 返回 JSON 数组，元素为 `Contact` 对象（结构与 `contacts/types.go` 对齐）。
- 关键字段包含：
  - `contact_id` / `kind` / `status`
  - `contact_nickname` / `persona_brief` / `persona_traits`
  - `pronouns` / `timezone` / `preference_context`
  - `subject_id` / `node_id` / `peer_id` / `addresses`
  - `understanding_depth` / `topic_weights` / `reciprocity_norm`
  - `created_at` / `updated_at` 及分享状态相关字段

## `contacts_candidate_rank`

用途：对当前候选池做排序，仅返回决策，不发送、不改状态。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `limit` | `integer` | 否 | 配置默认 | 返回决策上限。 |
| `freshness_window` | `string` | 否 | 配置默认 | 时长字符串，如 `72h`。 |
| `max_linked_history_items` | `integer` | 否 | `4` | 每条决策关联历史上限。 |
| `human_public_send_enabled` | `boolean` | 否 | 配置默认 | 是否允许面向公开聊天目标。 |
| `push_topic` | `string` | 否 | `share.proactive.v1` | 决策里填充的推送 topic。 |

说明：

- 本工具默认启用 LLM 特征抽取，使用全局 `llm.*` 配置。
- 人类联系人候选默认始终参与排序（等效 `human_enabled=true`）。

## `contacts_send`

用途：向单个联系人发送一条消息（自动路由 MAEP/Telegram）。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `contact_id` | `string` | 是 | 无 | 目标联系人 ID。 |
| `topic` | `string` | 否 | `share.proactive.v1` | 消息 topic。 |
| `content_type` | `string` | 否 | `application/json` | 必须是 envelope JSON 类型。 |
| `message_text` | `string` | 条件必填 | 无 | 文本内容；工具会自动封装为 envelope。 |
| `payload_base64` | `string` | 条件必填 | 无 | base64url 编码的 envelope JSON。 |
| `session_id` | `string` | 否 | 空 | 会话 ID（UUIDv7），对话类 topic 必填。 |
| `reply_to` | `string` | 否 | 空 | 可选，引用上一条消息 `message_id`。 |
| `source_chat_id` | `integer` | 否 | `0` | Telegram 路由线索。 |
| `source_chat_type` | `string` | 否 | 空 | Telegram 路由线索。 |

约束：

- `message_text` 与 `payload_base64` 至少提供一个。
- `content_type` 必须为 `application/json`。
- 若提供 `payload_base64`，其解码结果必须是 envelope JSON，并包含 `message_id` / `text` / `sent_at(RFC3339)`。
- 对话类 topic（`share.proactive.v1` / `dm.checkin.v1` / `dm.reply.v1` / `chat.message`）必须携带 `session_id`（UUIDv7）。
- 人类联系人发送受 `contacts.human.send.*` 策略约束。

## `plan_create`

用途：生成执行计划 JSON。通常由系统在复杂任务时调用。

参数：

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|---|---|---|
| `task` | `string` | 是 | 无 | 待规划任务描述。 |
| `max_steps` | `integer` | 否 | 配置默认（通常 6） | 最大步骤数。 |
| `style` | `string` | 否 | 空 | 计划风格提示，如 `terse`。 |
| `model` | `string` | 否 | 当前默认模型 | 计划生成模型覆盖。 |

## 备注

- 参数实际校验以代码为准：`tools/builtin/*.go`。
- 若 tool 被配置禁用，会返回 `... tool is disabled` 错误。
