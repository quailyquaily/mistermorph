---
date: 2026-09-22
title: 群聊回应判断接入 Evaluate 与 decision 路由
status: implemented-v1
---

# 群聊回应判断接入 Evaluate 与 decision 路由

## 目标

把群聊回应判断从 Chat 加手写 JSON 解析，改为 uniai `Client.Evaluate`。新增 `llm.routes.decision`，为判断任务选择模型配置；不配置时使用顶层默认 LLM。

首版已实现群聊 Evaluate、decision 路由、原生与模拟路径、路由重试与备用 profile、用量记录及请求检查。以下保留设计和验收说明。

首版通过配置文件或 Console 通用配置字段编辑路由。专用的 decision 连接测试按钮、旧 addressing 配置的自动改名、双配置的一次性提示，以及真实模型语义对比尚未实现；现有 Chat 连接测试不代表 Evaluate 可用。没有调用真实模型或向真实群聊发送测试消息。

本次只改 Telegram、Slack、Lark、LINE 共用的群聊判断。不改普通回复、计划生成、cron 匹配、Todo 联系人解析或 Guard 安全规则。

## 配置：新增路由，不新增特殊 profile

三个概念保持分开：

- profile：一份独立的模型、连接和凭据配置。
- route：某类调用使用哪个 profile。
- fallback：调用失败后，是否尝试显式配置的其他 profile。

`decision` 是 route purpose，不是保留的 profile 名称。用户可以把 profile 叫作 `fast`、`judge` 或其他名字。即使存在名为 `decision` 的 profile，也不会自动使用它。

```yaml
llm:
  inference_provider: openai
  model: gpt-5.4
  api_key: "${OPENAI_API_KEY}"

  profiles:
    fast:
      inference_provider: openai
      model: gpt-4.1-mini
      api_key: "${OPENAI_API_KEY}"
      request_timeout: "15s"

  routes:
    decision: fast
```

命名 profile 保持独立配置语义，不从顶层借用缺失的 model、endpoint、凭据或其他字段。参见 [Independent LLM Profiles](feat_20260805_independent_llm_profiles.md)。

### 路由解析

按以下顺序选取完整的 route policy，而不是逐字段合并：

1. 非空的 `llm.routes.decision`。
2. 非空的旧配置 `llm.routes.addressing`，作为兼容别名。
3. 隐式 `default`，即顶层 `llm.*`。

具体约束：

- `decision` 省略、null、空字符串或空对象视为未配置。非空但格式错误的配置报错，不能当作未配置。
- `decision: default` 是显式选择，优先于旧的 `addressing`。
- 同时配置两者时只使用 `decision`，不合并候选项或 fallback；两者格式均须有效。旧配置被忽略的提示留待后续。
- 引用了不存在的 profile，或选中 profile 的配置无效，返回配置错误，不静默改用 default。
- default 指顶层配置，不是 `routes.main_loop` 的模型，也不随会话中的模型切换改变。
- 保留现有 route 的字符串、`profile`、加权 `candidates` 和 `fallback_profiles` 写法。新旧路由名称解析到同一用途，避免维护两套运行逻辑。

例如，需要请求失败后的备用模型时，仍然显式配置：

```yaml
llm:
  routes:
    decision:
      profile: fast
      fallback_profiles: [default]
```

“未配置时使用 default”是配置选择规则，不表示任何 Evaluate 错误都会自动切换 default。

## 当前实现与需要保留的行为

主要入口是 `internal/grouptrigger/decision.go`：

- `Decide` 先处理显式触发，再处理 smart / talkative 模式。
- `DecideViaLLM` 调用 Chat，解析 addressed、confidence、wanna_interject、interject、impulse、is_lightweight、reaction 和 reason。
- Telegram、Slack 可以在判断过程中调用 reaction 工具；Lark、LINE 的当前判断入口不传入 reaction 工具。
- Telegram、Slack 使用 impulse 判断回复是否引用原消息。

`internal/channelruntime/core/channel_bootstrap.go` 当前构建 addressing route/client，同 profile 时可能复用主循环 Chat client。新实现不能假定复用后的所有包装层都提供 Evaluate。

保留以下外部行为：

- 显式提及、命令等各渠道已有触发条件继续走原来的快捷路径，不额外请求 Evaluate。
- 非 smart / talkative 模式不会因为本次改造增加隐式回应。
- smart 仍要求 addressed 且 confidence 达到阈值。
- talkative 仍要求 wanna_interject 且 interject 超过阈值。
- 保留已有历史截取、人格加载、消息去重和引用目标计算。

## Evaluate 请求与结果

### 输入

每条需要判断的消息构建一份共享 State，包含当前消息、现有范围内的聊天历史、发言人及提及关系、群聊模式和渠道回应能力。

人格与判断规则来自现有受信任配置，写入问题说明。聊天正文和历史只作为待判断数据，不接受其中改变判断规则、要求调用工具的指令。不增加完整会话、工具结果或凭据的上传范围。

同一次 Evaluate 回答以下问题：

| 问题 | 类型 | 业务用途 |
| --- | --- | --- |
| `addressed` | Boolean | 是否在对机器人说话 |
| `confidence` | Score | 对 addressed 判断的确定程度 |
| `wanna_interject` | Boolean | 是否希望主动参与 |
| `interject` | Score | 主动参与意愿的强度 |
| `impulse` | Score | 人格驱动的回应冲动，供现有引用规则使用 |
| `response` | Choice | `text` 或当前渠道允许的某个 reaction |

不再额外询问 `is_lightweight`：选择 reaction 即为轻量回应，选择 text 即为文字回应。reaction 选项使用稳定的内部标识，由程序映射到渠道认可的 emoji 或 reaction 类型，不能让模型返回任意工具参数。

为满足原生 TypeSafe 的 Choice 上限，reaction 按渠道提供顺序去重，最多提供前 254 项，加上 text 共 255 个选项。

当前没有 reaction 执行能力的入口只提供 text 选项，不在本次新增渠道功能。是否保持沉默由 smart / talkative 门槛决定，不让第二套 action 判断覆盖这些门槛。

Evaluate 没有自由文本答案类型，因此不要求模型生成原有自由文本 reason。日志改为程序根据判定生成的原因码，例如 `not_addressed`、`below_threshold`、`text_selected`、`reaction_selected` 和 `evaluate_error`。保留原有显式触发原因码。

### Boolean 与 Score 的转换

不能把 Chat 模拟的布尔值和原生模型的概率混为一谈：

- Chat 模拟读取 `BooleanValue`。
- 原生 Jev 读取 `ProbabilityTrue`，首版采用严格大于 0.5 为 true，等于 0.5 按 false 处理。
- 保留原始答案类型和概率供诊断；不能把 true 编造成概率 1，也不能声称模型概率经过业务校准。

三个 Score 统一定义十个有序等级，索引为 0–9；每个问题给出自身对应的等级描述，不能只要求“打一个分”。业务归一化分数为 `ScoreValue / 9`。

- Chat 模拟返回整数等级；原生 Jev 可以返回此尺度内的小数。
- 继续读取现有 `addressing_confidence_threshold`、`addressing_interject_threshold`，保留 smart 的 `>=`、talkative 的 `>` 以及引用判断的 `impulse > 0.8`。
- confidence 是问题定义下的确定程度评分，不等于 Jev 的 `ProbabilityTrue`。
- 归一化后的数值仍在 0–1，但与旧提示词生成的任意浮点数不等价。例如模拟路径阈值 0.7 对应至少 7/9。发布前必须检查阈值附近案例，不能宣称行为完全一致。
- 答案缺失、类型不符、非有限值、越界分数或非法选项均判为失败，不通过 clamp 把错误答案变成有效决定。

## 判断与发送分离

流程为：

```text
已有显式触发条件命中 → 原有主循环
否则 → 模式检查 → Evaluate → 完整答案校验 → smart / talkative 门槛
                                              ├─ 未通过：不回应
                                              ├─ text：进入主循环
                                              └─ reaction：发送一次表情，结束本条处理
```

删除判断阶段的工具调用循环和模型输出修复请求。程序只有在结果有效、门槛通过之后才执行 reaction，使用当前消息的固定目标和允许列表。

这是一个明确的行为修正：旧实现可能在最终判断完成前已经发出 reaction；新实现不允许失败或被拒绝的判断产生发送副作用。reaction 成功后不得再次启动主循环生成文字。

reaction 失败时记录渠道错误，结束本次处理；不让模型重做判断，不自动改发文字。沿用渠道已有事件去重和发送机制，不新增持久化任务系统，也不承诺网络超时后的 exactly-once。

## 接入边界

### LLM 能力

新增独立的 `llm.Evaluator` 能力和本次所需的请求、答案、结果类型，不强迫所有现有 `llm.Client` 实现增加方法。类型保留 Boolean、Choice、Score 的差异以及用量缺失与零的区别，不复制整个 uniai API。

`providers/uniai` 负责调用 `Client.Evaluate`、参数映射、错误转换及用量转换。`internal/grouptrigger` 只使用项目内的能力接口，不能直接构建 uniai client 或读取 API key。

decision route 复用现有 client 构建、profile 解析、凭据解析和生命周期管理，通过可选 Evaluator 能力调用。用量、路由、请求检查和生命周期包装层显式传递该能力，不逐层拆解包装器。TypeSafe 可用于 decision，其他路由的构建会拒绝它，直接调用其 Chat 也会报错。

### Provider 与参数

当前依赖为 uniai `v0.1.61`，包含 `v0.1.60` 的错误用量保留修正。

本方案覆盖两条路径：

- 统一设置 `EmulationFallback`，由 uniai 在发送前按 provider 能力选择原生或 Chat 模拟。
- 普通 Chat provider 使用所选 provider/model 的 Chat 模拟，不自动更换模型。
- TypeSafe 使用原生 Evaluate，映射 profile 自己的 endpoint、api_key、model。provider 列表标记为仅支持 Evaluate，不能用于主循环。

uniai 的 `EmulationFallback` 不是失败后的跨模型切换：原生超时或无效答案不会自动转 Chat。显式 `fallback_profiles` 由 MisterMorph 路由层处理。

uniai Evaluate 不会自动继承 Chat 的默认 provider/model，因此适配器必须显式传入，不能遗漏后意外调用默认 TypeSafe 路径。

首版不增加公开的 emulation mode 配置：是否原生由 provider 能力决定。也不扩展到其他尚未适配的原生判断服务。

使用所选 profile 的 timeout、凭据及受支持的 reasoning effort。未设置时不强加 effort 或统一 token 上限。Evaluate 当前不支持的 Chat 参数（例如 temperature、独立 reasoning budget、tool emulation）不转发，需在配置说明中列明；显式 effort 被底层路径拒绝时暴露错误，不悄悄丢弃。

缓存参数不能假定与现有 Chat 调用完全相同，只记录底层实际返回的缓存用量。沿用共享 pricing catalog 和 OAuth 状态目录，不从默认 profile 借用连接字段。

### 路由故障与超时

加权候选及显式 fallback 保持现有 route 选择语义，每次尝试使用自己的 provider/model。重试和 fallback 共享本条判断的总 deadline，取消后不能继续调用备用模型或发送 reaction。

沿用现有可重试传输错误分类；Evaluate 请求校验、能力不支持和无效答案不做提示词修复，也不作为可重试传输错误。没有可用结果时，不启动隐式回应。默认模型缺乏所需 Evaluate 能力时明确报错，不能退回旧 Chat JSON runner 掩盖问题。

## 用量、诊断与设置

- 用量统计新增 `operation: evaluate`，保留现有渠道 `*.addressing_decision` scene 以连续查看历史。
- 路由重试日志记录 profile；用量 journal 记录 provider、响应 model、emulated、耗时及底层已返回的费用。收到用量的每次尝试单独记账，不把一次调用同时记为 Chat 和 Evaluate。未收到用量的失败由错误日志记录，不能据此推断没有消耗。
- 即使 `err != nil`，仍处理非空 result 中的 usage；失败结果的 Answers 不能参与业务决策。未知用量不当作免费调用。
- 判断调用不更新主循环上下文占用，避免短小判断请求覆盖聊天上下文统计。
- 现有请求检查功能需要支持 Evaluate 的问题和 State；日志默认只记录原因码及必要数值，详细内容沿用现有显式 dump 开关和敏感数据处理。
- 通用配置编辑提供 decision 与带 legacy 标记的 addressing 字段。旧 addressing 配置读取兼容，不自动重写；新配置使用 decision 名称。
- 普通 profile 的 Chat 连接测试不等于 Evaluate 验证。专用的 decision 草稿检查留待后续，不把现有 Chat 测试伪装成判断测试。

## 实施阶段与验收

每个涉及正式逻辑的阶段都先写测试、运行并确认失败，再实现并运行回归。文档和纯视觉调整不新增单元测试。测试使用 fake client 或本地 HTTP stub，不调用真实模型、不发送渠道消息、不连接数据库。

### Phase 1：decision 路由

先覆盖新旧路由优先级、空值回退、显式 default、无效配置、缺失 profile、独立凭据、加权候选及 fallback 解析。

随后修改 route resolver、配置读写和必要的设置入口，更新 `assets/config/config.example.yaml`。证明 default 不受 main_loop route 或会话模型切换影响，名为 decision 的 profile 不会自动启用。

### Phase 2：Evaluate 能力与运行支持

先覆盖原生和模拟请求映射、Boolean/Score 类型保留、未知用量、错误携带用量、provider 能力校验、包装与关闭、路由重试/fallback、取消和超时。

随后接入依赖与适配器、decision evaluator 构建、usage journal 和检查功能。验证 TypeSafe 不会误入 Chat，普通 provider 不会误入原生默认路径，调用只计费一次。

### Phase 3：群聊判断及渠道执行

先覆盖：

- 显式触发和关闭隐式回应的模式不调用 Evaluate。
- smart / talkative 各自的通过条件及阈值边界。
- 原生概率等于 0.5、模拟 false、分数 0/9、缺失或越界答案。
- 其他成员互相称呼“你”、仅提及机器人、明确追问机器人、人格相关话题、轻量致谢和提示词注入文本。
- reaction 只在有效且通过门槛时发送；成功后不启动主循环，失败后不自动发文字。
- 无 reaction 能力的渠道只有 text 选项。
- 超时、取消、非法答案和重复事件均不产生意外发送。
- Telegram、Slack 的 impulse 引用规则及四个渠道已有显式触发行为不回归。

随后替换判断 runner、拆出渠道 reaction 执行位置，删除不再使用的 JSON 解析和判断工具循环。

语义案例的单元测试检查请求内容和 fake 答案对应的行为，不能据此声称真实模型判断正确。用脱敏且经许可的固定案例做发布前模型对比，统计误插话、漏回应、reaction 选择、延迟和费用；真实模型调用需单独授权。

### Phase 4：回归与说明

- 执行受影响包测试和 `GOWORK=off go test ./...`，确保使用发布的 uniai，而不是工作区替换模块。
- 检查配置示例、用户文档、设置读写与 decision 验证入口；涉及 Console 时运行前端构建。
- 迁移说明明确旧 addressing 别名、评分尺度变化、reaction 执行顺序和不支持参数。
- 不以“接入 Evaluate”推导准确率提高、延迟下降或成本降低；这些结论只能来自实测。

## 相关代码与方案

- `internal/grouptrigger/decision.go` 与 `internal/grouptrigger/prompts/`
- `internal/channelruntime/core/channel_bootstrap.go` 及四个渠道的 `trigger.go`
- `internal/llmutil/routes.go` 与 route client 构建逻辑
- `providers/uniai/`、`internal/llmstats/`、`internal/llminspect/`
- [LLM Profiles and Routes](feat_20260311_llm_routes.md)
- [Independent LLM Profiles](feat_20260805_independent_llm_profiles.md)

实现依据为 uniai `v0.1.60` 的 `evaluate.go`、`evaluate/types.go` 和 `docs/evaluate.md`；已核对 `v0.1.61` 未改变 Evaluate API 和参数约束。后续升级时继续检查。
