---
date: 2026-09-26
title: 历史消息、Prompt Cache 与上下文压缩重构
status: implemented
---

# 历史消息、Prompt Cache 与上下文压缩重构

## 1) 目标

把历史上下文放到本次运行的元数据之前，使连续任务可以复用更长的 prompt 前缀。同时重构历史消息边界、provider 缓存断点，以及上下文压缩和审批恢复，避免只改变消息顺序却没有改善缓存，或破坏运行状态。

本文记录实现约定及当前进度。消息顺序、逐条历史、meta 压缩保护和恢复，以及目标 provider 的历史显式断点均已实现。实际缓存收益尚未验证，详见第 12 节。

目标请求顺序：

```text
system
context checkpoint（如有）
historical message 1
historical message 2
...
mister_morph_meta
current_message 或原始 task
本轮追加的 assistant / tool / steer 消息
```

本设计实施后，取代 `feat_20260308_runtime_prompt_message_order.md` 中“meta 必须在 history 之前”的顺序约定。历史与当前消息分离、当前图片属于当前消息这两项约定继续有效。

## 2) 当前实现与问题

| 位置 | 当前行为 | 问题 |
| --- | --- | --- |
| `agent/engine.go` | 按 system、meta、checkpoint、history、current 组装 | meta 每次运行变化，过早打断共享前缀 |
| `internal/runtimeclock/` | 注入 `now_utc`、`now_local`、星期 | 时间精确到秒，不适合放在历史之前 |
| `internal/chathistory/prompt.go` | 整段历史渲染成一条 JSON user message | 追加历史会改写原来的消息结尾，无法保留逐条消息的缓存边界 |
| `internal/contextcheckpoint/history.go` | 只给整段历史提供一个末尾 boundary | 改为逐条消息后，需要同步提供逐条压缩边界 |
| `agent/engine.go` | 显式缓存标记放在 system 文本 part 上 | 没有为历史上下文建立显式缓存断点 |
| `providers/uniai/cache.go` | GPT-5.6 保留 system 标记，剥离其他消息标记 | 即使上层为历史增加标记，也无法传到 provider |
| `agent/context_compaction_*.go` | 用 `fixedMessageCount` 保护 system + meta | 保护语义依赖连续前缀，不能直接用于历史之后的 meta |
| `agent/engine_resume.go` | 恢复消息数组、固定前缀数量和各类索引 | 新顺序和 meta 保护信息需要一起保存和恢复 |

`run_id` 也在 meta 内，通常每次运行都不同。meta 在一次 `Run` 开始时生成，工具循环内不会每一步刷新。因此，这次优化的主要对象是同一会话的不同运行；一次运行内仍需保留已有追加式消息序列。

当前 `prompt_cache_key` 已由模型、scene、system 和工具定义生成，不包含运行时间或 `run_id`。不为本次重构增加会话、历史或时间哈希，也不改变现有 key 的分组语义。

## 3) 缓存约束

缓存复用需要一致的已渲染前缀。前面的内容变化后，不能跳过差异复用后面的历史。模型、工具定义及其顺序、输出格式等也可能影响实际前缀。[OpenAI 缓存规则](https://developers.openai.com/api/docs/guides/prompt-caching)

GPT-5.6 及之后的规则还要求存在可匹配的缓存断点。把原来的单条消息从 A 扩展为 A+B，可能失去 A 结尾处的查找边界；应保留原消息，追加新消息，或保留独立内容块的显式断点。[消息扩展与缓存边界](https://developers.openai.com/api/docs/guides/prompt-caching#extending-a-message-can-prevent-reuse-of-its-cached-prefix)

因此，这次实现需要同时满足：

1. 较稳定的历史位于动态 meta 之前。
2. 新增历史不改写已有历史消息的文本和边界。
3. 支持显式断点的 provider 能收到有效断点，并能在下一次请求中查找到旧边界。
4. 同一次运行内追加工具结果或 steer 消息，不移动已有 meta。

请求结构正确只是缓存命中的必要条件。缓存有效期、最小长度、模型设置和路由仍影响实际命中，单元测试不能证明线上缓存收益。

## 4) 历史消息改为逐条渲染

### 4.1 消息形状

普通渠道任务把每个 `ChatHistoryItem` 渲染为一条独立 `llm.Message`。外层 role 按真实来源映射，不统一使用 user：

| 历史来源 | 外层 role | 判断依据 |
| --- | --- | --- |
| 用户、群成员或其他 Agent 的输入 | `user` | 当前运行接收的外部输入，保留 sender 区分参与者 |
| 当前 Agent 已发送的回复 | `assistant` | 由当前 runtime 记录的 `KindOutboundAgent`，且属于当前 Agent 的会话历史 |
| reaction、渠道通知等事件 | `user` | 明确标为历史事件；不冒充 assistant 文本或 system 指令 |
| 原生工具执行记录 | 保留原角色 | 仅用于已经保存完整 tool call/result 协议的原生历史 |

角色由渲染前的 `ChatHistoryItem.Kind` 和可信 runtime 来源决定，不从用户文本推断。`Sender.IsBot` 不能用于判定 assistant：其他机器人也是外部参与者。内部 `KindSystem` 表示渠道事件，不能直接映射成模型的 system role。来源不明的记录作为带来源说明的外部上下文，不认作当前 Agent 的回复。

原先把整段渠道历史装进一条 user message，是提供参考资料的方式；拆成逐条对话后，应恢复能可靠识别的对话角色。缓存依赖内容、顺序和边界稳定，不要求所有消息使用同一个 role。

每条内容直接序列化现有 `PromptMessageItem`，不增加 `historical_message` 外层，也不逐条重复历史说明：

```json
{
  "sent_at": "2026-09-26T09:00:00Z",
  "sender": {
    "nickname": "Alice",
    "display_ref": "Alice"
  },
  "text": "Earlier message"
}
```

上述结构用于 user 历史消息。当前 Agent 的回复（assistant）改用 Agent 自己的回复格式，只保留文本：

```json
{
  "type": "final",
  "output": "Earlier reply"
}
```

原因：实测本地 qwen3.8-27b 时，assistant 历史若也用 `sent_at` / `sender` / `text` 记录，15 次中有 6 次模型照抄该记录作为回答，解析失败后需要重试；改用回复格式后 15 次中 0 次照抄（gpt-5.6-sol 两种写法均未照抄）。纯文本 assistant 历史更差：5 次全部输出非 JSON 文本。回复的时间和引用不进入 assistant 历史。实现继续使用 `PromptMessageItem` 保留现有的时间、sender、引用和图片说明。该结构当前不包含 `kind`、`channel`、`message_id`；角色映射和 boundary 计算在转换前使用原始历史项，不为此给每条 prompt 增加重复字段。

“前面的消息是历史、当前应处理 `current_message`”只在稳定的 system 规则和当前消息说明中表达，不为每条历史重复一遍。保留 sender、时间、引用和图片说明是为了支持群聊归属和上下文理解，不再添加承担相同作用的第二套结构。

渲染规则：

- 固定字段顺序；不加入渲染时间、历史总数或随窗口变化的序号。
- 相同历史项在相同渲染版本下产生相同文本。
- 追加历史只追加消息，不重写此前消息；不把相邻 user messages 合并为一条持续增长的消息。
- 当前消息继续使用 `current_message`，明确要求处理本次输入；相应指令改为引用历史消息，不再依赖旧的 `chat_history_messages` 数组。
- 当前图片继续附在当前消息上。历史图片说明、引用图片和已压缩图片的现有行为分别保留。
- 当前消息下一次成为历史时会改变包装。这是允许的；目标是此前已经属于历史的那段前缀保持不变。
- 历史 assistant 的包装表示已发送回复的记录，不作为当前输出格式。保留 system 中的最终回复格式要求，并在行为验证中检查模型是否错误输出历史包装。

主任务历史使用新的逐条渲染接口。群聊 addressing 等独立 LLM 请求若仍需要聚合 payload，保留它们的专用格式；不为统一命名而修改这些请求。

### 4.2 覆盖的入口和边界

迁移 Console、Telegram、Slack、LINE、Lark、Mixin 的主任务历史。检查 CLI chat/TUI 和嵌入调用方：已有原生 `[]llm.Message` 的历史保持原角色、parts 和 tool call/result 配对，不重复包装为渠道记录。

`HistoryBoundaries` 必须与过滤后的历史消息逐条对应。每条渠道历史使用已有 `BoundaryForItem`，使部分历史压缩后的 `CoveredThrough` 指向实际最后一条被覆盖的记录。不能继续把整段历史的末尾 boundary 赋给第一条消息。

现有 checkpoint 的 boundary 值继续有效，不重新生成历史记录 ID，不迁移历史存储。

### 4.3 以 assistant 开头的历史

渠道历史按条数截取尾部，窗口可能从当前 Agent 的回复开始；Agent 主动发出的消息（提醒、定时任务）也会成为第一条历史。checkpoint 是 user 消息，所以只有无 checkpoint 时才会出现 system 之后直接是 assistant。

Bedrock 文档要求 Claude messages 以 user 开头；Anthropic Messages API 文档没有此要求，经 Claude 路由实测也能接受；Gemini 的限制针对最后一条，OpenAI 兼容端点接受。uniai 的 Bedrock provider 使用 InvokeModel + Anthropic 消息体。provider 层对 `anthropic` 和 `bedrock` 在开头的 assistant 前插入一条固定的 user 消息 `(earlier conversation)`；其他 provider 不变，历史渲染和角色映射不变。

## 5) 缓存断点与 provider 适配

### 5.1 断点位置

使用已有 `llm.Part.CacheControl` 表达断点，不把 provider 字段写进 prompt 文本，也不增加通用缓存策略框架。

在现有缓存配置启用时，为以下内容提供断点：

1. system 末尾，保留共享指令的缓存。
2. 本次稳定上下文末尾：最后一条历史消息；没有历史时为 checkpoint；两者都没有时仅保留 system 断点。

这里的历史边界以本次运行的 meta 位置为准。后续工具循环不能把 meta 后面不断增长的对话误当成跨运行历史，再移动这个断点；provider 自身对本轮工具对话的自动缓存继续工作。

不能把动态 meta 当作“历史缓存”的断点。不能以最后一条历史存在为由，假定上一轮的历史断点必然能命中：provider 请求测试需要覆盖历史增长后的旧消息边界查找条件。

本次只增加稳定上下文末尾这一个断点，旧边界查找使用 provider 已支持的行为。不增加旧断点列表、逐条标记策略、断点调度器或额外持久化状态。超出 provider 原生查找范围时，允许缓存复用减少；用测试说明限制，不承诺任意历史增长都能命中。

若依赖库会合并消息或丢失断点，必须修复该具体适配问题并验证正文与内容块边界，不为它新建通用缓存层。保留断点的效果须按实际 provider 协议验证。

断点只作用于请求副本，不修改调用方历史、持久化 checkpoint 或历史记录。文本从 `Content` 转成 `Parts` 时只能发送一次，不能重复文本或丢失图片。

### 5.2 provider 行为

| 路径 | 本次要求 |
| --- | --- |
| OpenAI / OpenAI Responses 的 GPT-5.6 路径 | 保留合法的历史文本断点，继续结合 implicit caching；取消当前对非 system 标记的统一剥离 |
| 使用自动前缀缓存的其他 OpenAI 模型 | 继续按已支持协议发送请求，受益于消息顺序；不发送不支持的显式标记 |
| Anthropic | 在现有显式缓存适配上支持历史断点，检查 TTL、断点数量和旧边界复用 |
| Bedrock | 按实际 provider 转换能力处理；不能直接照搬 Anthropic 或 OpenAI 字段。uniai 的 Bedrock provider 只接受 Claude 模型 ARN 上的消息断点（其他 ARN 整个请求被拒），因此按配置的 ARN 判断，非 Claude ARN 剥离全部断点 |
| 其他兼容端点 | 保留现有能力判断；不根据“OpenAI-compatible”推定支持新的缓存字段 |

模型能力判断继续放在 provider 层。不通过未来版本号猜测协议能力，不在 engine 中增加模型名称分支。

沿用 `cache_ttl` 等现有配置语义；关闭配置时不新增显式标记或缓存参数。服务端自身的自动缓存不由客户端这个开关保证关闭。本次不新增用户配置项，也不改 TTL、计费策略或 cache key 算法。

验收必须检查最终 HTTP 请求或依赖库实际序列化的请求，不能只断言中间 `llm.Request` 有 `CacheControl`。

## 6) meta 保护与上下文压缩

### 6.1 把保护原因与位置分开

保留一个按模型实际顺序排列的消息数组。`fixedMessageCount` 只表示真正固定的前缀，正常运行中为 system；不再用它保护 meta。

engine 单独记录自己注入的 meta 消息位置。该信息属于运行状态，不进入 prompt 文本。不得扫描任意 user 消息的 JSON key 来判定“这是受保护的 meta”，否则用户或历史中的同名 JSON 会被误认。

只新增一个可表示“无 meta”的位置字段。历史缓存边界由 meta 前一条消息推导，不再保存 `historyEnd`、`cacheEnd` 或第二份消息数组。已有 `HistoryBoundaries` 标识持久化历史记录，承担压缩后去重职责，与 meta 的数组位置不是同一份状态。

meta 始终满足：

- 每个正常请求只出现一次。
- 原始历史和 checkpoint 在它之前，初始当前消息在它之后。
- 工具结果、格式重试和 steer 追加时不移动它，不刷新其时间或 `run_id`。
- 不发送给 checkpoint 总结请求，不因压缩而删除，不写入 checkpoint 内容。
- token 预算仍计入它的实际输入大小；不能把保留 meta 的 token 计为压缩释放量。

### 6.2 压缩跨过 meta 时的行为

meta 是保留消息，不是阻止后续压缩的永久分界。不能简单把它加入不可跨越的 protected block，否则旧历史压缩完后，后续工具对话可能再也无法压缩。

压缩仍选择完整的连续对话区间，但从总结输入中排除 engine 自己注入的 meta。替换该区间时保留这条消息：

| 选中范围 | 替换后的行为 |
| --- | --- |
| 完全位于 meta 之前 | 用 checkpoint 替换选中历史，按删除数量更新 meta 位置 |
| 包含 meta，且包含可总结对话 | 用 checkpoint 替换被总结的对话，随后放回原 meta，再接未压缩尾部；选区恰好结束在 meta 之后时也适用 |
| 只有 meta，没有可总结对话 | 不形成有效压缩选区 |

示意：

```text
压缩前：system → old history → meta → old tool exchanges → recent tail
压缩后：system → checkpoint  → meta → recent tail
```

这使 meta 保留，同时允许后续多次压缩继续前进。压缩后前缀改变，旧缓存可能不再命中；后续请求从新的 checkpoint 重建缓存，不为维持旧缓存而保留无用历史。

索引更新必须覆盖 `messageBoundaries`、临时 protected indexes、图片位置和 meta 位置。工具调用与结果保持完整，不把 meta 插入一组 tool call/result 中间。`CoveredThrough` 只来自被总结的对话记录，meta 不提供 boundary。

缓存断点根据压缩后的实际历史边界重新生成；不能残留指向已删除 part 的标记。

### 6.3 Hook、预算与请求检查

现有 Hook 接收实际消息数组。当前内置 interactive Hook 只追加 user 消息，保留这一行为，不为它增加重排协调机制。engine 自己执行压缩替换时更新相应索引，并校验 meta 位置有效。

本次不实现“任意 Hook 改写消息后自动重建所有索引”的通用能力。外部 Hook 的结构性修改若破坏受维护位置，必须明确报错，不能根据 JSON key 猜测修复，也不能误把普通消息当作 meta。实施前检查现有 Hook 回归，避免改变仅追加消息的调用方行为。

输入预算、日志、请求 dump 和实际 provider 请求使用相同消息内容。断点适配不能改变正文，压缩选择不能把未释放的固定内容算进释放量。

## 7) Checkpoint 与审批恢复

已有 checkpoint 只存总结消息及覆盖边界，本次保持其存储格式和 revision 并发检查。

审批恢复状态需要明确表示新消息布局及 meta 位置。采用新的 resume state 版本，继续读取当前支持的旧版本；不把新字段缺失默认为消息索引 0。

版本变化有实际用途：旧程序若忽略新增位置字段，会按旧压缩逻辑处理新布局，可能删除 meta。新版本号使旧程序明确拒绝无法理解的快照。新程序不维护两套执行或压缩引擎；恢复旧状态后，继续使用它原有的固定前缀边界进入同一个运行循环。

兼容策略：

- 新状态保存完整消息数组、meta 位置、固定前缀数量及现有边界和保护信息，恢复后保持同一运行的原顺序和原 meta。
- 当前旧版本保存 `system + meta` 固定前缀。对旧的待审批任务按其已保存布局及原有兼容规则恢复并完成，不为缓存优化重排旧快照，也不重新执行已经完成的工具。
- 新启动的运行统一使用新布局。不为旧布局增加用户可选开关。
- 校验新状态的 meta 位置、固定前缀和边界范围；校验在消费审批之前完成。
- 原有 action hash 绑定、checkpoint revision 冲突检测、pending tool 去重语义保持有效。

缓存标记在恢复请求时按 provider 能力处理，不在恢复时生成新的 `run_id` 或时钟信息。

## 8) 范围与已知限制

本次必须一起修改消息顺序、历史渲染、缓存断点、压缩和恢复。system 中 persona、技能发现和业务规则的组织方式不重做。

以下因素仍会使缓存前缀变化，需要在验证结果中说明：

- Console 当前只恢复最近 6 个任务；滑动窗口移除最早记录时，共享历史前缀会变化。
- checkpoint 更新、历史编辑或重置会改变前缀。
- system 中的文件引用、图片会话状态等动态内容，以及按任务变化的工具集合，会限制历史缓存收益。
- 模型、scene、persona、技能列表或 provider 配置改变，可能改变缓存 key 或实际前缀。

不在这次增加历史保留量、不迁移 journal、不自动把所有动态 system blocks 移到 user role、不增加缓存服务或持久化缓存账本。这些变更分别涉及上下文成本或指令权限，不能只为缓存一起修改。

## 9) 实现阶段与测试

每个正式代码阶段先添加或更新测试，运行并确认预期失败，再实现，最后运行对应回归。本文及其他纯文档修改不加测试。测试使用 mock、内存状态或临时文件，不连接数据库。

### Phase 1：消息顺序、meta 保护和恢复

这一阶段原子完成 engine 顺序变化与保护逻辑，不能先提交会使 meta 被压缩的中间状态。

先覆盖：

- 有无 history、checkpoint、CurrentMessage，原始 task 回退和 `SkipTaskMessage`。
- 新顺序、当前图片归属、system 历史过滤，以及普通内容中的伪 `mister_morph_meta` 不被保护。
- 同一运行的工具循环、格式重试和 steer 不刷新或移动 meta。
- 压缩停在 meta 之前、跨过 meta、连续多次压缩、图片准备失败、完整工具交换。
- meta 不进入总结输入或 checkpoint，实际请求中始终保留一次。
- `CoveredThrough`、消息索引、token 释放估算和 Hook 相关行为。
- 新状态 round-trip、旧状态恢复、非法索引、审批重复执行保护及 checkpoint 冲突。

实现后运行 agent 和 contextcheckpoint 相关回归。

### Phase 2：逐条历史与逐条 boundary

先覆盖相同历史的稳定渲染、追加历史的前缀不变、部分历史压缩后的准确过滤，以及历史/当前消息分离。验证当前 Agent 的回复映射为 assistant，其他机器人仍为 user，reaction 和 `KindSystem` 不升级为模型指令；不根据用户提供的 `kind` 或 `is_bot` 文本改变角色。

迁移所有主任务渠道和 Console。验证 sender、时间、引用、图片说明不丢失，原生 CLI chat/TUI 历史不被重新包装。更新 `PreparedHistory` 和调用方的逐条 boundary，检查当前消息说明文字与新 payload 一致。

实现后运行 chathistory、contextcheckpoint、各渠道和 CLI/Console 后端的相关回归。

### Phase 3：缓存断点与 provider 请求

先覆盖 system + history、system + checkpoint、仅 system、缓存关闭，以及文本和图片混合消息。

构造同一会话的连续两次请求：改变 meta 和当前消息、追加历史，检查旧历史消息边界保留，最终 provider 请求包含该模型支持的断点和缓存字段。覆盖压缩后、审批恢复后和超出 provider 原生查找范围的情况；后一种只验证请求正确及限制明确，不增加自动补偿策略。

检查不支持显式缓存的路径仍剥离相应标记；检查文本只发送一次、原历史和 checkpoint 不被修改、工具顺序和 cache key 不受本次 meta 变化影响。

实现后运行 provider 的序列化测试，再运行 `go test ./...` 和 `go vet ./...`。同步更新 `docs/prompt.md` 和当前 prompt architecture 指南；保留历史 feature 文档作为设计记录。

### Phase 4：收益验证

本地确定性验证与实际 provider 验证分开记录：

- 本地验证最终请求的公共前缀、消息/内容块边界和断点，不能把公共前缀长度标为真实命中 token 数。
- provider 验证固定模型、system、工具、推理设置和 cache 配置，在缓存有效期内对比改造前后的连续请求。
- 分别验证跨运行的历史增长、同一运行的工具循环，以及窗口滚动或压缩后重新建立缓存。
- 从已有 usage 记录比较 cached input tokens、cache write tokens（如 provider 提供）、总 input tokens、延迟和实际输入成本；不能只比较命中百分比。
- 没有凭据或未做付费 API 实测时，明确标记“结构验证通过，实际缓存收益未验证”，不报告推测的节省比例。

## 10) 验收条件

1. 新运行的顺序为 system、checkpoint、逐条历史、meta、当前消息；本轮后续消息仅追加。
2. 追加历史不改写已存在的历史消息，逐条 boundary 与消息一一对应；外层 role 正确区分当前 Agent 的回复与外部输入。
3. 支持显式缓存的目标路径收到有效历史断点；其他路径不收到不支持的字段。
4. 实际序列化请求保留历史边界，不合并成持续改写的大消息。
5. meta 不参与总结，不写入 checkpoint，不因压缩或恢复重复、丢失或变成旧历史。
6. 压缩可以跨过 meta 并继续压缩后续对话，连续压缩不被 meta 永久阻断。
7. 工具交换、当前图片、steer、审批恢复和 checkpoint 并发检查保持正确。
8. 旧审批状态可恢复完成，已有 checkpoint 无须迁移。
9. 相关回归、全仓 Go 测试和静态检查通过；实际缓存收益与结构验证分别报告。

## 11) 第一性原理审阅

必要行为只有四项：历史语义正确、已有前缀稳定、provider 能缓存支持的边界、压缩和恢复不丢运行信息。

据此删除或限制以下设计：

| 设计 | 处理 | 原因 |
| --- | --- | --- |
| 每条历史增加外层 envelope 和同一条 note | 删除 | 原生 role、现有记录字段及一次说明已经足够 |
| 历史末尾、缓存末尾分别保存索引 | 不增加 | 可由唯一的 meta 位置推导 |
| 为所有旧断点维护列表和调度策略 | 不增加 | 原生缓存能力足以支撑本次改造，超出查找范围不影响任务正确性 |
| 任意 Hook 重排后的通用索引修复 | 不增加 | 当前内置 Hook 只追加消息，通用修复会扩大接口范围 |
| 新旧布局各自维护运行循环 | 不增加 | 旧状态的固定前缀信息已经足够进入同一个运行循环 |

以下复杂度仍然必要：角色映射、逐条 boundary、一个 meta 位置、跨 meta 压缩的保留处理、provider 序列化适配、新恢复状态版本及旧状态读取。它们各自保护现有行为，不能仅为减少代码行数而删除。

## 12) 实现与验证结果

已实现：

- 新消息顺序，以及各主任务渠道和 Console 的逐条历史、角色映射和逐条 boundary。
- 一个可选的 meta 位置；压缩跳过其内容并保留原消息，支持跨过 meta 的连续压缩。
- 版本 2 的审批快照，以及旧快照按原布局恢复到同一个运行循环。
- 请求副本中的历史末尾缓存标记，不修改持久化历史或 checkpoint。
- 本地 HTTP 测试确认 Anthropic 和 OpenAI GPT-5.6（Chat Completions 与 Responses）保留 system 和历史标记，消息正文不重复，相邻消息边界保持正确。

依赖已更新至 `uniai v0.1.63`，包含 [uniai #19](https://github.com/quailyquaily/uniai/issues/19) 的校验与序列化修复。OpenAI GPT-5.6 路径保留 system、user 和 assistant 文本上的断点，继续剥离不支持的工具定义标记；关闭缓存或使用不支持显式断点的模型时，继续剥离相应标记。

HTTP 测试覆盖 user 和 assistant 历史末尾，确认断点只出现在 system 和历史消息上，meta 与当前消息不带断点；同时覆盖关闭缓存和不支持显式断点的模型。

验证结果：`go test ./...`、`go vet ./...` 和 `git diff --check` 均通过；另以 `GOWORK=off go test ./...` 和 `GOWORK=off go vet ./...` 验证发布的 `uniai v0.1.63`，两项均通过。未调用付费模型 API，实际缓存命中率和成本收益尚未验证。
