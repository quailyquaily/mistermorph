---
date: 2026-10-01
title: 微信与 WhatsApp Channel 接入调研
status: research
---

# 微信与 WhatsApp Channel 接入调研

## 1. 结论与范围

建议先做两个**个人与 Agent 的专用私聊入口**：微信使用腾讯 iLink Bot 协议，WhatsApp 使用官方 Agent Platform v1。两者都是 HTTP 接口与长轮询，适合桌面端和自行部署的 Morph，不需要公网 webhook。

**不使用第三方 Go 接入库。** 在仓库内用 Go 标准库实现必要的 HTTP、JSON、鉴权、轮询和媒体处理。腾讯插件及其他项目仅用于查证协议；不把 OpenClaw、whatsmeow、Baileys 或其他语言的 SDK 作为运行依赖，也不通过旁路进程间接接入。

当前「微信」尚未进一步限定为个人微信、公众号、微信客服或企业微信。本文按「在自己的聊天软件中与 Morph 对话」作为工作假设，保留其他路线的区别。**这里的扫码或 token 接入不等于接管个人账号的全部好友与群聊。**

| 项目 | 微信 iLink | WhatsApp Agent Platform v1 |
| --- | --- | --- |
| 一手依据 | 腾讯维护的插件、协议说明及源码 | WhatsApp 官方开发手册，2026-08-25，Version 1 |
| 认证 | 扫码确认后取得 Bot token | 手机内创建 Agent，复制该 Agent 的 API key |
| 接收 | `POST /ilink/bot/getupdates` | `GET /agent/v1/updates` |
| 发送 | `POST /ilink/bot/sendmessage` | `POST /agent/v1/messages` |
| 已确认的范围 | 官方插件声明 `direct` | 只能给创建该 Agent 的用户发消息 |
| 普通群聊 | 未确认，不列入首版 | v1 未提供，不列入首版 |
| 公网入口 | 不需要 | 不需要 |
| 推荐顺序 | 先实现，先验证扫码与文本回复 | 随后实现；先检查目标账号是否有 Agents 入口 |

以上是基于文档和源码的设计建议，**本次没有账号登录、真实收发或计费验证**。微信入口与 WhatsApp Agents 的地区、客户端版本及账号开放情况，仍须用目标账号确认。[腾讯项目说明](https://github.com/Tencent/openclaw-weixin)、[微信能力声明](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/channel.ts)、[WhatsApp 官方手册](https://www.whatsapp.com/developer/WhatsApp-Agent-Platform-Developer-Manual.pdf)

## 2. 为什么选这两条路线

### 2.1 微信

腾讯已经公开 iLink 插件及其 HTTP 协议，不能再沿用「个人微信只能走非官方库」的旧结论。插件通过微信授权建立 Bot 会话；源码的 `capabilities.chatTypes` 只有 `direct`。类型中的 `group_id` 不构成群聊可用的证据。

| 路线 | 对应需求 | 本次处理 |
| --- | --- | --- |
| iLink Bot | 微信用户与自己的 Agent 对话 | 主方案，直接实现协议 |
| 公众号 | 用户向公众号发消息 | 另一种账号产品；不能当成个人微信接入 |
| 微信客服 | 企业客服接待 | 另一种业务流程；若需求转为客服，再单独验证权限和会话窗口 |
| 企业微信应用或智能机器人 | 企业内应用和机器人会话 | 应独立命名为 `wecom`，不与个人微信混在同一配置中 |
| 非官方个人号协议、客户端 Hook | 读取好友、普通群聊等 | 不选；需要额外协议维护且不符合本次简单直接的实现目标 |

本次尝试读取公众号、微信客服及企业微信的官方文档，但页面未成功返回可读正文，因此不写入其最新额度、审核要求或群聊能力结论。可进一步核查的官方入口为[公众号文档](https://developers.weixin.qq.com/doc/offiaccount/Getting_Started/Overview.html)、[微信客服开发文档](https://kf.weixin.qq.com/api/doc/path/93304)、[企业微信开发文档](https://developer.work.weixin.qq.com/)。

### 2.2 WhatsApp

WhatsApp 现在有独立的 **Agent Platform**，不能与 Cloud API、Meta Business Agent 或 WhatsApp Web 关联设备协议混为一谈。官方手册明确给出了个人用户创建 Agent 后的直接 HTTP 接口。

| 路线 | 账号及范围 | 对本项目的判断 |
| --- | --- | --- |
| Agent Platform v1 | 手机创建 Agent；只与创建者通信 | 首选，HTTP 长轮询可直接实现 |
| Business Platform / Cloud API | 商业账号与客户通信 | 若将来需要多客户客服，再独立设计 |
| WhatsApp Web 多设备协议 | 作为账号关联设备参与私聊、群聊 | 不选；不是几个 HTTP 请求就能替代 SDK |

`whatsmeow` 的公开代码涉及设备密钥、Signal 会话、应用状态同步、重试与 JID/LID 映射。自行实现这条路线会把 channel 工作扩大为一个协议客户端项目。[项目源码](https://github.com/tulir/whatsmeow)、[设备状态存储](https://github.com/tulir/whatsmeow/blob/8b41cfe6d9c487e17858cf00be40e951f575dbe8/store/sqlstore/container.go)

## 3. 微信 iLink：协议与实现要点

源码基线：`Tencent/openclaw-weixin@24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c`。腾讯协议文档明确说明，它归纳的是客户端行为，**不是完整的服务端契约**。下文区分已见实现和 Morph 的设计建议。

### 3.1 登录与凭据

默认 API 地址为 `https://ilinkai.weixin.qq.com`。

1. `POST /ilink/bot/get_bot_qrcode?bot_type=3` 获取二维码信息。
2. `GET /ilink/bot/get_qrcode_status?qrcode=...` 轮询确认状态。
3. 成功响应提供 `bot_token`、`ilink_bot_id`、`ilink_user_id`、`baseurl`；保存完整的绑定关系。

除等待、扫码、成功、过期外，当前登录实现还处理验证码及重定向状态。首版不能只实现「扫码成功」这一条路径。二维码优先展示服务端返回的内容，不为终端二维码渲染引入 Go 接入库。[登录实现](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/auth/login-qr.ts)

Bot 请求携带 Bearer token、`AuthorizationType: ilink_bot_token`、`X-WECHAT-UIN` 和应用版本头，JSON 内带 `base_info`。二维码查询的鉴权规则与 Bot API 不同，不能用一个无条件添加 token 的请求函数覆盖所有接口。`bot_agent` 是可观测标识，Morph 应使用自己的名称；版本字段兼容性在协议验证阶段确认。[API 请求源码](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/api/api.ts)

### 3.2 轮询、回复与状态

| 接口或字段 | 已见行为 | Morph 设计 |
| --- | --- | --- |
| `getupdates` / `get_updates_buf` | 将响应游标用于下次请求 | 保存为不透明字符串，不解析、不递增 |
| `longpolling_timeout_ms` | 服务端可给出下次轮询时长 | 独立于发消息超时；退出时用 context 取消 |
| `sendmessage` / `context_token` | 回复携带入站上下文；官方代码在缺失时仍尝试发送 | 默认要求有效上下文；缺失时给出明确错误，不能承诺任意主动发送 |
| `client_id` | 客户端为发送请求生成 | 保存用于关联；未证实服务端去重前，不视为幂等保证 |
| `getconfig` / `sendtyping` | 获取 ticket，设置或取消输入状态 | typing 失败不阻断最终回复 |
| `ret` / `errcode` | HTTP 成功仍可能业务失败；`-14` 在官方客户端触发会话暂停 | 区分暂时故障与需要重新授权，避免不断重试 |

消息中的数值 ID 不应经过 `float64`。Go 使用保留精度的解码方式，再转为内部字符串。不要把平台 `session_id` 当作 Morph 持久会话的唯一标识。[协议说明](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/docs/protocol_zh_CN.md)、[轮询实现](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/monitor/monitor.ts)

首版发送完整文本，不实现逐 token 推送或原地编辑。官方插件的分块发送不等于服务端支持编辑同一条消息；`GENERATING` 枚举也不足以证明可直接套用 Telegram 的流式策略。[消息发送实现](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/messaging/send.ts)

### 3.3 媒体与尚未确定的能力

腾讯实现覆盖文本、图片、语音、文件、视频；语音消息可能带转写文本。媒体需处理 CDN 参数和 AES-128-ECB / PKCS#7，不是直接把下载链接交给模型。Go 的 `crypto/aes` 可提供块加解密，填充、长度及密钥校验需自行实现并先写测试。[媒体类型](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/api/types.ts)、[媒体加密源码](https://github.com/Tencent/openclaw-weixin/blob/24de5c9eb0dd5e595d7e2d090ed8a3f82870d42c/src/cdn/aes-ecb.ts)

以下不作首版承诺：普通群聊、读取既有好友聊天、主动联系任意用户、上下文令牌的固定有效期、商业 SLA、具体账号额度及长期免费。官方客户端的行为不能替代这些服务端保证。

## 4. WhatsApp Agent Platform v1：协议与实现要点

本节依据官方开发手册 Version 1（2026-08-25）。浏览工具未能读取 PDF 的 CDN 重定向，随后从同一官方 URL 直接下载并提取了完整正文；没有执行下载内容。

### 4.1 创建、身份与权限范围

手机路径为 `Settings > Agents > Create an agent`；在 Agent 会话的 `Chat info > API key` 获取 token。接口基址是 `https://api.whatsapp.com/agent/v1`，使用 `Authorization: Bearer <token>`。token 为不透明字符串，轮换后旧值失效；手册要求卸载应用后重新生成 token。

**Agent 只能向其创建者发消息。** 收件人取入站 `messages[].from`，保留完整的 `user:<id>`。`agent:<id>`、裸手机号或其他格式不能作为收件人。用户换号或重新注册后标识可能变化，因此不能按手机号猜测或自动合并联系人。

产品可用性仍需目标账号验证：文档存在不等于所有地区和客户端均已开放 Agents。官方条款注明最多连接 5 个第三方 Agent，并说明这些专用 Agent 对话不采用个人聊天的端到端加密。[开发手册第 3–6 页](https://www.whatsapp.com/developer/WhatsApp-Agent-Platform-Developer-Manual.pdf)、[第三方 Agent 条款](https://www.whatsapp.com/legal/third-party-agents-terms)

### 4.2 端点及关键限制

| 端点 | 用途 | v1 限制或注意事项 |
| --- | --- | --- |
| `GET /updates` | 长轮询消息和回执 | `timeout` 0–25 秒；`limit` 默认 50、最多 100；15 次/分钟/Agent |
| `POST /messages` | 发文本或媒体 | 文本 4096 字符；12 次/分钟/Agent；同一收件人串行发送 |
| `POST /statuses` | 已读与 typing | 12 次/分钟/Agent；typing 最长 25 秒，回复时消失 |
| `POST /media` | multipart 上传 | 图片 5 MB；贴纸 500 KB；视频、音频、文档及通用二进制 16 MB |
| `GET /media/{id}` | 取得元信息与下载 URL | 下载也需鉴权，媒体保存 30 天 |
| `DELETE /media/{id}` | 删除媒体 | 每种媒体方法分别限 12 次/分钟/Agent |

限流是按 Agent、按方法、滚动 60 秒计数。不能仅在收到 429 后才控制速度，也不能因轮询立即返回就无间隔发起下一次请求。[开发手册第 4、16–23、28 页](https://www.whatsapp.com/developer/WhatsApp-Agent-Platform-Developer-Manual.pdf)

标准库已足够实现首版：`net/http`、`encoding/json`、`mime/multipart`、`time`、`context`。不需要 Meta Go SDK，也不需要自行实现 WhatsApp Web 的设备加密。

### 4.3 游标、回执与恢复

`updates` 返回 `entry[].changes[].value.messages` 和 `statuses`，两者共用序列。`next_offset` 是有符号 64 位整数，必须原样回传，不用消息 ID 计算，也不自行加一。

- 不传 `offset`：从请求到达时的队列头开始。不能每次都省略，否则两次请求之间的更新可能丢失。
- `offset=0`：读取仍保留的历史，最多 30 天。首次启用时不得把所有旧消息作为新任务执行。
- HTTP 204：正常空响应，没有 JSON 和新游标，保留已有 offset。
- HTTP 409、错误码 `1752041`：新的轮询替换了旧轮询。一个 Agent 只能有一个活跃 poller；CLI 与 Console 同时启动必须被阻止或明确报错。
- 标记已读后，消息可能从可回读记录中删除，崩溃后无法重放。因此首版不发送已读回执（见 5.2）。`/statuses` 的 typing 请求必须带 `status: "read"`，发 typing 就等于标记已读，所以首版也不发 typing。

**启动策略（与 Telegram 对齐，见 5.2）**：游标只保存在内存中，每次启动都从 `offset=0` 读取，之后原样使用服务端返回的 `next_offset`。已处理过的消息由现有的入站去重挡住；早于启动时刻 24 小时的消息只推进游标、不触发任务。24 小时与 Telegram 服务端保留未确认更新的时长一致，所以两个 channel 在停机后的行为相同：停机一天内的新消息会被处理，更早的不会。排空 30 天历史时要遵守轮询限速。[开发手册第 9–16、26–28 页](https://www.whatsapp.com/developer/WhatsApp-Agent-Platform-Developer-Manual.pdf)

### 4.4 发送、重试与进度输出

发送体使用 `messaging_product: "whatsapp"`、`to`、`type` 及对应内容对象。引用回复用 `context.message_id`，成功后保存返回的 `wamid`。

| 结果 | 处理建议 |
| --- | --- |
| 2xx | 记录成功，不重复发送 |
| 429 | 遵守限流并退避 |
| 503 且 `error.code=131016` | 手册明确未接收投递，可退避重试 |
| 其他 4xx | 修正请求或凭据；403 收件人错误不能反复重试 |
| 500、连接重置、读取超时 | 结果未知，不能保证安全重试；记录为发送结果不确定 |

首版不做逐 token 输出、消息编辑或原生审批按钮，v1 没有提供相应接口。**不发送计划进度消息**（其他 channel 靠编辑同一条消息更新进度，WhatsApp 不能编辑）。其余行为与其他 channel 一致：每个完成步骤的备注作为一条消息发送，然后是最终答案；审批提示、`/stop` 等反馈照常发送。所有发送都经过同一个按收件人串行、按方法限速的发送队列，超出 12 次/分钟时排队等待而不是丢弃。不发 typing（见 4.3：typing 会连带标记已读）。收到 reaction 只更新事件状态，不能默认将表情当作审批决定。[开发手册第 8–9、11–17、25–28 页](https://www.whatsapp.com/developer/WhatsApp-Agent-Platform-Developer-Manual.pdf)

### 4.5 Cloud API 作为另一条路线

Cloud API 有商业账号、手机号、访问权限及 webhook 配置要求；它不是上述 token 的另一个基址。Meta 官方 Postman 集合列出 Business Portfolio、WABA 和业务手机号等接入资产。[Meta 官方集合](https://www.postman.com/meta/whatsapp-business-platform/collection/wlk6lh4/whatsapp-cloud-api)

截至本次可读的 2026-09-23 商业消息政策，普通非模板回复受 24 小时客户服务窗口约束。它会影响长任务结果、cron 与主动联系，不能照搬其他 channel。[现行消息政策](https://business.whatsapp.com/policy)

通用 AI 助手的 Business Platform 准入规则与计费也不能直接套用旧文章：旧版条款包含 AI Providers 限制和地区例外，但其入口现在重定向到需要登录的新条款；本次未取得新版完整正文。公开营销定价页与最新费率详情也未能完成交叉核实，故本文不宣称 Cloud API 免费或在所有地区可用于通用助手。Agent Platform 使用自己的官方条款，不应把旧 Cloud API 限制直接套到它上面。[商业条款入口](https://www.whatsapp.com/legal/business-solution-terms)、[定价入口](https://business.whatsapp.com/products/platform-pricing)

因此，Cloud API 仅作路线对比，本次不设计双后端切换，也不把 Business 群聊权限作为已具备能力。

## 5. 与现有仓库的接合点

调研基线是提交 `5bdcc20b`。当前已实现 Discord；旧设计文档中的「尚无 runtime」不是现状。代码也已存在 LINE webhook，不能依据早期仓库说明判断项目完全没有入站 HTTP 能力。

| 现有位置 | 新 channel 需要处理的内容 |
| --- | --- |
| `internal/channels/channels.go`、`internal/bus/message.go` | 注册 `wechat`、`whatsapp` 及校验分支 |
| `internal/bus/conversation_key.go` | 加入会话前缀，保留账号与对端作用域 |
| `internal/bus/adapters/inbound_flow.go` | 注册 channel；沿用入站去重，不绕过 bus |
| `internal/bus/adapters/<channel>/` | 平台事件转消息、出站目标验证 |
| `internal/channelruntime/core/`、`taskruntime/` | 复用任务、历史、命令、审批、取消和 steering |
| `internal/channelopts/`、`cmd/mistermorph/root.go` | 配置、CLI 入口、参数验证 |
| `cmd/mistermorph/consolecmd/managed_runtime.go` | 托管 runtime、取消轮询、热重载、连接状态 |
| `cmd/mistermorph/consolecmd/console_settings.go` | 配置读写、secret 状态、授权状态 |
| `contacts/`、`internal/contactsruntime/sender.go`、`internal/entryutil/refid/` | 联系人引用、出站路由及目标范围限制 |
| `internal/promptprofile/` | 告知模型私聊、发送限制与不支持的能力 |
| `web/console/src/` | 两个 channel 的设置、状态、标签和翻译 |
| `assets/config/config.example.yaml` | 随实现同步实际配置键 |

建议新增 `internal/wechatapi/`、`internal/whatsappapi/`，各自持有 HTTP client 和平台错误处理；对应 runtime 放在 `internal/channelruntime/wechat/` 与 `whatsapp/`。沿用现有分层，不新建通用消息平台、SDK 插件注册器或只重命名函数的包装层。

### 5.1 身份与会话

引用格式沿用现有约定：`<channel>:<聊天>` 指会话，`<channel>_user:<用户>` 指人（如 `discord:` / `discord_user:`、`line:` / `line_user:`）。

| 对象 | 微信 | WhatsApp |
| --- | --- | --- |
| 用户（联系人 ID、`admins`、`contacts_send` 目标） | `wechat_user:<peer_id>` | `whatsapp_user:<id>` |
| 会话（`chat_id`、cron 通知目标） | `wechat:<peer_id>` | `whatsapp:<id>` |
| bus 会话键（含账号，见下） | `wechat:<bot_id>:<peer_id>` | `whatsapp:<agent_id>:<id>` |

两个 channel 都只有私聊，会话与用户一一对应；仍分开两种前缀，保持与其他 channel 一致，将来若支持群聊也不必改格式。

WhatsApp 的用户标识是 `user:<id>`，本身含冒号。内部只保存 `<id>`，发送时再拼回 `user:`；这样所有引用和会话键都不出现嵌套冒号，解析按固定段数（`strings.SplitN`）即可，不需要转义规则。入站 `from` 不是 `user:` 开头时拒绝，不做猜测。

首版每个 channel 只运行一个绑定账号，但账号身份必须进入去重和状态作用域，避免重新绑定后读到旧账号的游标或上下文。去重键至少包含 channel、账号、平台消息 ID；平台没有声明 ID 全局唯一时，再包含会话。

微信 `context_token` 放在受保护的 channel 状态中，不进入模型提示词、通用联系人字段或日志。WhatsApp token 不包含可供本地解析的 Agent ID，应从平台响应取得并验证账号身份；轮换 token 不应无条件清空同一 Agent 的历史。

**同一账号只允许一个 poller。** 微信同一个 token、WhatsApp 同一个 Agent（409，见 4.3）都不能被两个进程同时轮询。在 `file_state_dir` 下按账号建锁文件（如 `locks/wechat-<bot_id>.lock`，记录进程 ID 与启动时间）：`morph wechat` / `morph whatsapp` 和 Console 托管 runtime 启动前都先取锁，取不到时报错并说明是哪个进程占用；锁的持有者已退出时可接管。Discord 文档目前只提醒「不要同时运行」，这里改为由代码保证。

WhatsApp 联系人表示「这个 Agent 的创建者」，不是任意可联系用户。`contacts_send`、cron 和其他出站入口都要验证目标属于当前绑定；`agent_send` 不能向 `agent:<id>` 发送，首版不提供 Agent 间配对能力。

### 5.2 可靠性：与现有 channel 对齐

**轮询游标**是「下次从哪里接着取消息」的位置标记：微信是 `get_updates_buf`，WhatsApp 是 `next_offset`。现有 channel 也有同类东西：Telegram 长轮询的 `getUpdates` offset，Discord Gateway 的 sequence 号。它们**都只保存在内存里，不写盘**：

- Telegram 取到更新后立即推进 offset，再交给 bus；重启后从 0 读，服务端重放仍未确认的更新（最多 24 小时），重复的由 `InboundFlow` 的已见记录去重（`internal/channelruntime/telegram/runtime_owner.go` 的 `poll()`）。
- 因此现有 channel 的语义是：崩溃时可能丢失正在处理的任务，但同一条消息不会被执行两次。没有持久的待处理队列。

首版两个 channel 采用相同语义，不新增持久队列：

| | 微信 | WhatsApp |
| --- | --- | --- |
| 游标 | 内存中保存 `get_updates_buf`，不解析、不递增 | 内存中保存 `next_offset`，原样回传 |
| 启动 | 以空游标开始；服务端会返回哪些消息需在 Phase 0 验证，重复消息由去重挡住 | 见 4.3：`offset=0`，跳过 24 小时前的消息 |
| 去重 | 现有 `InboundFlow`，键含 channel、账号、平台消息 ID | 同左 |
| 已读回执 | 无 | **首版不发送**：标记已读后消息可能从可回读记录中删除，崩溃后无法重放 |

持久的待处理队列若需要，应作为所有 channel 的共同需求另行设计，而不是只在这两个 channel 上实现。

**连接状态**：两个 channel 都区分未配置、等待授权、在线、暂时断线、需要重新授权，沿用 Discord/Slack 的连接标志展示方式；不能把「启动了 goroutine」当成已连接。退出或热重载先取消旧 poller，再启用新 poller。

### 5.3 建议配置与首版范围

以下只是拟议配置，不表示仓库已支持：

```yaml
wechat:
  bot_token: ""        # 扫码登录写入；也可用 MISTER_MORPH_WECHAT_BOT_TOKEN
  bot_id: ""           # 扫码登录写入，不是密钥
  base_url: ""         # 扫码登录返回的服务地址，不是密钥
  task_timeout: "0s"
  max_concurrency: 3
  serve_listen: ""

whatsapp:
  api_token: ""        # 也可用 MISTER_MORPH_WHATSAPP_API_TOKEN
  task_timeout: "0s"
  max_concurrency: 3
  serve_listen: ""

console:
  managed_runtimes: [wechat, whatsapp]
```

两个 channel 都不设白名单：微信只有扫码人能与 Bot 对话，WhatsApp 只允许创建者与 Agent 通信，平台已经限定了使用者。

**密钥与现有机制对齐**：`wechat.bot_token` 和 `whatsapp.api_token` 与其他 channel 的 token 一样，可以写明文、写 `${ENV}`、写 `internal/secref` 的引用（环境变量、AWS Secrets Manager、系统密钥库），也可以由 `MISTER_MORPH_*` 环境变量提供。Console 设置里只写不读，保存时与其他 channel 一样存入系统密钥库、配置里只留引用。扫码登录得到的 token 走同一条路径（见 5.4）。

`context_token` 不是配置，也不是长期凭据：它随每条入站消息到达，回复时带上。首版只保存在内存中，与会话状态一起；重启后下一条入站消息会带来新的 `context_token`。因此依赖旧上下文的延迟发送（cron、重启后发出的长任务结果）首版不承诺，见 5.3 能力表和第 7 节。

`serve_listen` 仍指 Morph 的 runtime 管理接口，不是平台回调地址。首版不增加 provider/mode 选择、不暴露没有用途的群触发配置；固定平台限额放在协议客户端中。测试通过注入 HTTP transport 完成，不要求用户配置任意 API 地址。

| 能力 | 首版处理 |
| --- | --- |
| 文本、引用、历史、`/stop`、steering | 接入已有任务路径；微信引用能力以实际协议验证为准 |
| 审批 | 复用文本 `/approve`、`/deny`，验证发送者、会话及有效期 |
| 计划反馈 | 与其他 channel 一致：步骤备注作为消息发送，再发最终答案；WhatsApp 不发计划进度消息、不编辑消息，发送统一排队限速 |
| 图片输入、文件输出 | 文本路径稳定后补充，不把未知媒体当作文本任务 |
| cron / 主动通知 | WhatsApp 限创建者且需有效标识；微信依赖 `context_token`，首版未确认，不承诺 |
| 群聊、陌生联系人、Agent 间消息 | 不支持，明确拒绝 |
| 流式编辑、按钮、语音通话 | 不在首版范围 |

### 5.4 微信扫码登录流程

微信没有可以预先填写的 token，必须先扫码。登录流程是首版的一部分，CLI 和 Console 都要提供：

**CLI**：`morph wechat login`

1. 调用 `get_bot_qrcode`，在终端打印服务端返回的二维码链接；若返回的是图片，保存到 `file_cache_dir` 并打印路径。不为渲染终端二维码引入依赖。
2. 轮询 `get_qrcode_status`，逐行显示状态：等待扫码、已扫码待确认、需要验证码（提示在手机上完成）、已重定向、已过期（提示重新执行）、成功。
3. 成功后写入配置：`bot_token` 存入系统密钥库，`wechat.bot_token` 写引用；`bot_id`、`base_url` 写明文。系统密钥库不可用时（例如无桌面会话的服务器），不把 token 写进配置明文，而是打印出来并提示用户设为 `MISTER_MORPH_WECHAT_BOT_TOKEN` 或自行写入配置。
4. `morph wechat` 启动时若没有 token，报错并提示先运行 `morph wechat login`。

**Console**：设置页微信面板

- 未绑定时显示「连接微信」按钮；点击后由后端发起登录，面板显示二维码和实时状态（同上），过期时可刷新。
- 绑定后显示账号（`bot_id`）、连接状态和「重新授权」「解除绑定」；解除绑定删除密钥库中的 token 和配置中的账号信息。
- 登录请求由 Console 后端代理，二维码查询的鉴权规则与 Bot API 不同（3.1），token 不经过浏览器。

**需要重新授权**：轮询或发送返回会话失效（如 `errcode=-14`）时，runtime 停止重试，状态改为「需要重新授权」，Console 面板和 Runtime 页显示，CLI 日志给出执行 `morph wechat login` 的提示。

WhatsApp 不需要这一流程：用户在手机上复制 API key，填进配置或 Console，与其他 channel 的 token 一样。

## 6. 建议实施顺序与验收

本次仅写调研。后续每个涉及正式逻辑的 Phase 都应先添加测试、运行确认失败，再实现到通过。单元测试使用标准 `testing`、fake transport、fake clock 和临时文件。

| Phase | 工作 | 先写的测试与验收条件 |
| --- | --- | --- |
| 0：确认账号入口与协议 | 分别检查微信授权、WhatsApp Agents；保存脱敏样例 | 明确能否登录、能否给自己收发、重启后是否可恢复；有凭据后的手工验证单独进行 |
| 1：微信文本 | 内部 HTTP client、`morph wechat login` 与完整登录状态、轮询、文本发送 | 请求头、验证码/重定向、业务错误、ID 精度、取消、上下文隔离、游标恢复、重复消息不重复运行 |
| 2：WhatsApp 文本 | token、轮询、串行发送、方法级限流 | 204、int64 offset、启动时跳过 24 小时前的消息、409 冲突、回执不触发任务、仅创建者可发、429、明确可重试与结果未知的区分 |
| 3：runtime 与 Console | CLI、托管生命周期、按账号的 poller 锁、Console 扫码面板、secret、命令、审批和联系人 | 换号隔离、热重载单 poller、重启后去重、不重复执行、跨会话审批拒绝、任务取消不关闭整个 runtime |
| 4：媒体和通知 | 图片、文件、有限主动发送（WhatsApp typing 不做：需连带已读回执） | 大小上限、hash/密钥/填充校验、媒体 URL 与重定向检查、到期凭据、限流合并、文本及媒体各自发送状态 |

媒体请求不得把 API token 无条件转发到任意 URL。依据实际官方响应限制下载目标及重定向；下载与解密都设大小上限。二维码、token、微信上下文和媒体密钥都属于敏感状态，日志只记录请求阶段、状态码和必要的消息关联 ID。

文档和 UI 视觉变化不额外编写测试。实现完成后运行相关包测试、Console 现有测试与构建，再做有明确账号范围的手工收发检查。

### 6.1 实施进度（2026-10-01）

Phase 1–4 已实现，尚未用真实账号手工收发：

- 协议 client：`internal/wechatapi`（含 CDN 媒体的 AES-128-ECB 加解密、上传与下载；下载只接受微信域名的 https 地址，CDN 请求不带 bot token）、`internal/whatsappapi`（含 `/media` 上传、元信息与下载；token 只发往 WhatsApp 自身域名，校验 SHA-256 与大小上限，媒体方法各自限速）。全部以 fake server 测试。
- 共用私聊引擎 `internal/channelruntime/accountdm`，transport 在 `internal/channelruntime/wechat`、`internal/channelruntime/whatsapp`；按账号的 poller 锁 `internal/runtimelock`。
- 媒体：入站图片交给模型（每条最多 3 张），其他文件、视频、未转写语音存入 `file_cache_dir/<channel>/` 并在消息里注明路径；重放的消息先查收件箱，不会重复下载。出站由 `wechat_send_file` / `whatsapp_send_file` 工具发送 `file_cache_dir` 内的文件。
- 主动发送：`internal/livesend` 让同一进程里运行中的 runtime 代为发送，`contacts_send`、cron（`chat_id` 为 `wechat:<user>` / `whatsapp:<user>`）和 heartbeat 都走这条路。微信仍受 `context_token` 约束，只能发给启动后发过消息的用户。heartbeat 发给账号的使用者（微信的扫码人、WhatsApp 的创建者），使用者记在 `file_state_dir/accountdm/`，重启后照常通知。`morph wechat` / `morph whatsapp` 在开启 heartbeat 或 cron 时同时运行 awareness runtime。
- CLI：`morph wechat`、`morph wechat login|logout`、`morph whatsapp`。
- Console：托管 runtime、设置页（微信扫码面板、白名单；WhatsApp API key 只写不读）、扫码接口 `/settings/wechat/login/start|poll`、`/settings/wechat/logout`；token 只在服务端保存，浏览器只拿二维码链接。Runtime 页显示连接状态（含需要重新登录）。
- 嵌入：`integration.Runtime.NewWeChatBot`、`NewWhatsAppBot`。
- 文档：`docs/wechat.md`、`docs/whatsapp.md`，VitePress 三语参考页。

未做：Phase 0 真实账号验证；SILK 语音转码与语音转写；WhatsApp typing（需连带已读回执）。

## 7. 实现前仍需验证的事项

1. 两个平台在目标微信/WhatsApp 账号上的入口是否开放，是否需要特定客户端版本。
2. 微信以 Morph 自身身份填写协议元数据后的兼容性，扫码重定向可接受的域名范围。
3. 微信 `context_token` 的有效期、重新登录后的行为，以及延迟任务和 cron 是否可用；不自行假设 24/48 小时窗口。
4. 两个平台重启、网络中断、凭据轮换和发送结果未知时的实际表现；文档存在不代表已经实测。
5. WhatsApp 创建者标识变化时的重新绑定流程；既有联系人不能靠显示名或猜测手机号自动关联。
6. 微信文本和媒体的真实服务端上限、频控与账号限制；当前插件参数只作为客户端实现参考。

这些事项会影响具体实现和产品描述，但不改变当前技术选型：**先对接官方的 Agent 私聊 HTTP 协议，用仓库内的 Go 代码实现，不引入第三方 Go 接入库。**
