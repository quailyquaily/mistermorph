---
date: 2026-09-17
title: TUI 复用 Console Topic
status: proposed
---

# TUI 复用 Console Topic

## 1. 决策

为 `mistermorph chat` 增加显式的 runtime 连接模式，让 TUI 成为现有 Console runtime 的另一个客户端。Web 与 TUI 共享 topic ID、历史、上下文、workspace 和任务执行状态，而不只是共享话题标题。

保留现有 standalone chat，不自动启动 Console，不让两个进程直接读写同一份 topic/task 状态。第一版一次连接一个 Console runtime；不做多 endpoint 工作台。

本文合并原两份 TUI shared topics 方案及 review 修正，作为唯一实施方案。本文是待实现方案，不表示所列 CLI 参数已经存在。

共享模式要求 runtime 在线；连接失败或服务端停机不得自动退回 standalone 执行。若以后需要 Web 未运行时继续共享会话，另行比较自动启动共用 runtime 与多进程存储，不作为本次前提。

## 2. 当前实现与复用边界

| 位置 | 当前职责 | 本方案处理 |
| --- | --- | --- |
| `cmd/mistermorph/chatcmd/chat.go` | 构建本地 chatSession 并进入 REPL；`--endpoint` 指 LLM endpoint | 保留 standalone 分支，另加远端入口，不能复用该 flag 表示 runtime |
| `cmd/mistermorph/chatcmd/session.go` | 按 workspace 或启动目录计算项目哈希，conversation key 为 `chat:<projectID>` | 远端模式不构建本地 agent session，不使用该 key |
| `cmd/mistermorph/chatcmd/bubble.go`、`repl.go` | 现有终端交互与任务生命周期 | 复用展示和输入交互，不沿用本地 agent 的执行/取消所有权 |
| `internal/taskdomain/domain.go` | `TopicInfo`、`TaskInfo` 领域类型 | 继续作为数据模型，不另建 TUI topic 模型或持久化格式 |
| `internal/daemonruntime/server_routes_tasks.go` | topic 查询、删除、重新生成标题、任务提交/查询/停止 | 直接复用 runtime HTTP contract |
| `cmd/mistermorph/consolecmd/local_runtime.go` | Console 任务执行、workspace、上下文、删除清理；conversation key 为 `console:<topicID>` | 唯一执行方和状态写入方 |
| `cmd/mistermorph/consolecmd/streaming.go` | 按 task 推送 WebSocket 帧 | 复用实时输出；HTTP 查询仍为恢复状态的依据 |
| `web/console/src/views/ChatView.js` | 话题选择、历史展示、提交、删除、重新生成标题 | 对齐行为，不移植 Vue 状态管理 |

需要纠正一个容易误解的前提：现有 `/topics` 不是完整 CRUD。它没有独立创建空 topic 的 POST，也没有手动改名的 PATCH。Web 新建目前是本地草稿，第一次提交 `/tasks` 时不传 `topic_id`，由后端返回实际 ID；已有标题操作是 `regenerate-title`。第一版遵循这些现有语义，不为了 TUI 先补一套 CRUD。

### 为什么不直接共享文件

Console store 的 journal 文件锁不等于跨进程运行时协调：内存投影需要同步，启动恢复会处理非终态任务，stop、steer 和审批续跑还依赖进程内状态。让 TUI 再打开同一 store，必须额外解决执行互斥、投影刷新和崩溃恢复。复用同一 runtime 避免引入这套机制。

TUI 的上下键输入历史不是完整聊天记录。模型历史恢复、压缩窗口和 checkpoint 覆盖范围继续由 Console 处理，客户端只投影展示历史，不自行拼装另一套模型上下文。

## 3. 范围

第一版包含：

- 列出、分页加载、筛选和切换现有 Console topics。
- 新话题草稿、首次发送后创建话题。
- 加载任务历史、继续对话、查看运行进度、显式停止任务。
- 删除话题、重新生成标题。
- 展示并操作服务端 workspace；显示实际连接地址和当前话题。
- 断线恢复和任务轮询回退。

第一版不包含：

- 手动改名、空话题持久化、标签、归档、跨 endpoint 搜索。
- 自动迁移 `chat:<projectID>` 的历史或 checkpoint 到 Console。
- 自动拉起后台进程、离线执行、后台运行时托管。
- 完整复制 Web 设置页、文件预览、附件上传和多 agent desk。
- 为共享 topic 另建存储、消息总线或通用 transport 插件系统。

手动改名如后续需要，应先补领域层的标题更新和 revision 冲突语义，再让 Web/TUI 使用同一接口，不能通过伪造一次 task submission 实现。

## 4. CLI 与连接

拟新增参数：

```bash
# 原有行为保持不变
mistermorph chat

# 连接已启动且开放 runtime API 的 Console
mistermorph chat --runtime-url http://127.0.0.1:9080/runtime

# 直接继续指定话题
mistermorph chat --runtime-url https://morph.example.com/morph/runtime --topic <topic-id>
```

- `--runtime-url` 是完整 runtime API base URL，客户端不猜测或额外追加 `/runtime`。
- `--topic` 只在连接模式有效；找不到或已删除时报错，不静默创建同名话题。
- 拟使用环境变量 `MISTER_MORPH_CHAT_RUNTIME_TOKEN` 提供目标 runtime 的 `server.auth_token`。不提供命令行明文 token 参数，不把 token 放进 URL、历史或错误日志。
- 认证复用 `Authorization: Bearer ...`，不走浏览器 `/api/proxy`、Console session 或 WebSocket ticket。
- Console 只有显式配置 `server.auth_token` 才开放 `/runtime`。连接失败应区分地址错误、未开放路由、认证失败和服务不可达，并给出对应提示。
- 启动时先检查 `/health`，确认目标为 Console runtime，再做受保护的 topics 请求。第一版不把 Telegram 等 runtime 的会话当成可编辑 Console topic。
- 非 loopback 明文 HTTP 拒绝发送 token，要求 HTTPS 或用户通过本机安全隧道访问。
- 本地 provider、LLM endpoint、API key、skills 和执行限制类显式覆盖参数，在连接模式下应拒绝，不能悄悄忽略或影响本地进程。服务端设置保持服务端所有权；第一版使用其默认 profile。
- `--workspace`、`--no-workspace` 第一版只用于 standalone；远端模式明确报错。远端 workspace 在话题或新建草稿中显式操作，避免客户端 cwd 自动覆盖服务端附件。

不记住上次选择也能完整使用第一版：未指定 `--topic` 时打开选择器。后续如增加本地偏好，只保存 endpoint 与 topic ID，不保存共享历史或 token。

## 5. 终端交互

### 5.1 `/topics` 列表视图与标题栏

在聊天输入框输入 `/topics` 并提交后，进入独立的 topics 列表视图，而不是在聊天记录里打印列表。列表只展示**当前 workspace dir** 下的共享 topics，不默认混入其他目录的话题。

- 视图顶部显示用于筛选的完整 workspace dir；每行展示标题、简短 ID 和更新时间，按更新时间倒序排列。
- `↑` / `↓` 移动高亮选择，不触发切换或执行；`Enter` 加载选中 topic，成功后进入该 topic 的聊天视图，继续其原有历史和上下文。加载失败留在列表并显示错误。
- `Esc` 返回进入列表前的聊天视图，保留原 topic 和输入草稿；启动时尚无聊天视图则留在列表。列表获得键盘焦点时，方向键不触发聊天输入历史。
- 提供“新建话题”和“加载更多”。从此视图新建时，将筛选目录作为草稿待提交的 workspace，确保首次发送创建的话题属于该目录；这不是提前创建服务端 topic。
- 可输入标题或 ID 筛选当前目录下已加载的项目，并明确提示搜索范围；不声称这是后端全量搜索。
- 加载中、加载失败和空列表分别展示；没有匹配项时 Enter 不进入其他目录的话题。分页或刷新保留高亮 topic ID，选中项消失时才调整位置，不自动进入话题。

**workspace 范围定义：**共享模式中，“当前 workspace dir”指当前 topic 的服务端实际解析目录；新建草稿使用待提交目录，无待提交目录或启动时无 topic 则使用服务端默认解析目录。不能把客户端 cwd 当作远端路径。进入列表时固定本次筛选目录，刷新不因后台 workspace 变化悄悄换范围；再次执行 `/topics` 时重新解析。目录按服务端返回的规范路径精确匹配，不做前缀匹配，不把子目录视为同一 workspace。无有效目录时明确显示“未绑定 workspace”分组，不能退化为全部 topics；解析失败则显示错误，不猜测默认目录。

列表筛选不改变 topic 的 workspace，也不是访问控制。`--topic` 和 `/topic switch <id>` 仍允许显式进入其他目录的话题，进入后标题栏与后续 `/topics` 范围随该话题的实际 workspace 更新。standalone 模式不伪造共享列表，执行 `/topics` 时提示需通过 `--runtime-url` 连接 Console runtime。

标题栏展示 endpoint、当前 topic 标题、服务端 workspace 和连接状态。窄屏缩写标题但保留可查看完整 ID 的入口。保留现有 TUI 布局，不要求第一版新增常驻侧栏。

### 5.2 命令

| 命令 | 行为 |
| --- | --- |
| `/topics` | 进入当前 workspace dir 的 topics 列表视图；↑/↓ 选择，Enter 进入，Esc 返回 |
| `/topic new` | 切到未提交的新话题草稿，不创建持久化记录 |
| `/topic switch <id>` | 查询目标存在后切换 |
| `/topic history` | 展示当前话题历史并提供加载更早一页 |
| `/status` | 显示完整 endpoint、topic ID、任务状态、workspace 和服务端上下文元数据 |
| `/topic title regenerate` | 调用现有标题生成接口；显示失败或并发冲突 |
| `/topic delete` | 确认后删除当前话题；提示正在运行的任务也会被停止 |
| `/stop` | 明确停止当前 topic 的任务，不影响其他 topic |
| `/workspace` | 已有话题读取服务端解析结果；草稿显示待提交路径或“使用服务端默认值” |
| `/workspace attach <path>` | 已有话题修改服务端 attachment；草稿只记录待提交路径。路径均按服务端文件系统解释 |
| `/workspace detach` | 已有话题调用服务端解除 attachment 并展示解析结果；草稿清除待提交路径，恢复使用服务端默认值 |
| `/exit`、`/quit` | 退出客户端，不停止后台任务 |

未创建 topic 的草稿不能调用要求实际 topic ID 的 stop/title/delete 操作，应提示先发送消息。草稿 workspace 是本地待提交状态，不提前写服务端 attachment；首次 `POST /tasks` 携带 `workspace_dir`，由服务端校验并在执行前绑定。未指定或清除路径不代表禁用 workspace，只代表使用服务端默认值；客户端不以本地目录存在性代替服务端验证。特殊 topic 的保护规则以服务端为准，不能在 TUI 绕过。

远端模式明确区分本地界面命令与服务端命令。`/models`、`/ctx` 等只在核实服务端 contract 后提供，不能直接复用 standalone handler；不支持的斜杠命令本地报错，不误发给模型。尤其不能把本地 `/reset` 当作清除共享上下文来执行。

### 5.3 切换、草稿与取消

- 切换只改变查看对象，不取消旧话题的任务；离开 TUI 同样不取消。先验证目标并读取历史，成功后替换视图，失败保留原选择和输入。
- 保留原生 scrollback，不清空终端；切换成功打印话题分隔和最近记录。刷新不重复打印整段历史，不清空草稿或重置已加载历史页。
- 第一版保留进程内按 topic 隔离的输入草稿，退出后不承诺恢复。新建草稿最多保留一个，重复新建不静默丢弃已输入内容。
- 删除必须确认。现有 Console 删除逻辑会调用 stop 并清理 checkpoint 等状态，TUI 只调用删除 API，不自己重写清理流程。
- 删除成功后回到选择器；其他客户端删除当前 topic 时，显示失效状态并禁用发送，不自动换成另一个 topic。
- Ctrl+C 仅清理当前输入或退出客户端，不能沿用本地任务取消路径来隐式停止服务端任务；停止统一通过明确的 `/stop`。

## 6. API 使用

以下路径均相对于 `--runtime-url`：

| 操作 | 现有接口 |
| --- | --- |
| 列表与继续加载 | `GET /topics?limit=...&cursor=...` |
| 检查话题 | `GET /topics/{id}` |
| 查询历史 | `GET /tasks?topic_id=...&limit=...&cursor=...` |
| 提交消息 | `POST /tasks`，已有话题传 `topic_id` |
| 新建话题 | `POST /tasks` 不传 `topic_id`，采用响应中的 `topic_id` |
| 查询任务 | `GET /tasks/{id}` |
| 停止话题任务 | `POST /topics/{id}/stop` |
| 重新生成标题 | `POST /topics/{id}/regenerate-title` |
| 删除话题 | `DELETE /topics/{id}` |
| workspace | `GET/PUT/DELETE /workspace`，按现有方法契约传递 topic ID |
| 上下文元数据 | `GET /topic/{id}/metadata` |
| 实时输出 | `/stream/ws`，按既有 task 订阅参数和帧结构连接 |

workspace 筛选按服务端实际解析结果执行，不假设 `GET /topics` 已支持工作目录筛选参数或列表记录自带有效目录。实施时核对现有 workspace 查询契约；若列表不含该信息，先复用按 topic 查询 workspace 的接口，以有界并发解析并在客户端过滤。沿原始 topics cursor 翻页，直到凑够匹配项或确认末页；单页无匹配不代表该目录无话题，部分查询失败也不能当成不匹配或空列表。查询必须异步、可取消，迟到结果不得写入另一个目录的列表。第一版不为此预建索引或另存目录到 topic 的映射。

正常流程不新增后端 API。保留 runtime 的错误分类、分页 cursor 与特殊 topic 约束。标题生成冲突不自动反复重试。

新话题提交成功前没有真实 ID，不在客户端生成临时 ID 冒充领域 ID。响应成功后将原草稿绑定到后端返回的 topic/task，再刷新列表；若用户已切走，不抢占当前视图。请求已发送但响应丢失属于提交结果未知，不自动重发 POST，避免重复任务或重复 topic；提示用户刷新历史核实。

## 7. 状态与并发

服务端拥有 topic 元数据、任务生命周期、上下文、workspace、checkpoint、审批和执行配置。客户端仅拥有选中项、输入草稿、历史展示缓存、连接状态和订阅资源。

### 7.1 视图与操作生命周期

异步查询和订阅携带 endpoint/topic/task 标识及视图 generation。切换后旧回包不能写进新窗口，取消旧视图的查询/订阅只释放客户端资源，不触发服务端 stop。

写操作不属于视图生命周期。发送时分配进程内操作 ID，关联原 topic 或草稿、提交内容和待提交 workspace 快照；切换不取消提交，也不丢弃成功结果。回包先更新原操作及其 topic/task 归属，再按当前视图决定是否显示。删除等写操作同样只更新其目标，不能因迟到响应跳走当前查看的话题。

一个新建草稿在首次提交未决时不能再次提交；结果未知时保留核实状态，不把它当成尚未发送的新草稿。成功后仅清除该次提交对应的输入版本，不覆盖用户后来编辑的内容。操作 ID 不冒充服务端幂等键，不要求新增幂等 API；退出客户端也不承诺保存未决操作。

### 7.2 历史投影

- 原始任务按 task ID 合并去重，以服务端时间和稳定 ID 为基础顺序。普通任务投影为用户消息及该任务的回复/状态，用 task ID 与角色形成稳定展示标识。
- steer synthetic task 的用户输入通过 `steer_target_task_id` 关联目标任务。对齐 Web `chat-history-steering.js`：目标 assistant 回复放在已加载的相关追加指令之后；接收反馈作为系统状态，不当成独立 assistant 最终答案。
- 跨分页暂时缺少目标任务时保留 steer 输入及关联 ID，不伪造目标回复。加载目标任务后重新投影并去重；实时提交和重新加载历史使用同一规则。
- HTTP 终态结果替换同一任务的流式预览，不重复追加答案。失败、取消与 pending 明确区分。原生 scrollback 已打印内容不能重排时，以带 task 归属的状态更新展示；重新打开历史必须得到一致的规范顺序。
- 实时帧使用现有 `task_id`、`seq` 等字段过滤重复和过期消息，WS 不是完整历史日志。

### 7.3 选中话题同步与任务跟踪

现有 WS 按 task 订阅，不是 topic 事件流。必须区分两种同步：

1. **选中 topic 同步**：持续低频刷新 topic 元数据、最新任务页和 workspace；按 ID 合并而非覆盖已加载旧页。发现其他客户端新增任务后启动任务跟踪；发现标题、workspace 变化及时更新，确认被删除后禁用发送并保留输入。两次刷新之间新增任务超出一页时，继续翻页直到遇到已知边界，不能只读取最新一页而漏消息。
2. **任务跟踪**：跟踪已发现的非终态任务，HTTP 查询为状态依据，WS 作为预览增强；任务进入终态仅停止该任务的轮询/订阅，不停止 topic 同步。pending 仍需跟踪。

切走时停止旧 topic 的查询和订阅，切回重新同步；后台其他 topic 不各自保持无限连接。刷新串行或合并触发，避免慢请求堆积及旧快照覆盖新状态。

断线后显示 stale 状态并退避重连；重连重新查询 topic、历史和未完成任务。WS 不可用仍能 HTTP 轮询，网络错误不能当成话题已删除。刷新不得清空输入、改变选中项或重置历史分页。

### 7.4 多端发送与审批

Web 和 TUI 可以同时查看或发送。提交期间的 steer/排队等语义完全服从现有 Console runtime（其提交路径已含运行中任务 steer 处理），不增加 TUI 本地“每 topic 单任务锁”。对 steer 响应正确关联目标任务，不把反馈当作独立 assistant 最终答案。

任务进入 `pending` 时显示等待审批及 approval ID，第一版可提示到 Web 完成审批；不能把 pending 当成结束或无限显示 running。TUI 不在本地作出独立授权决定，也不注册 standalone 的 `/approve`、`/deny` handler；审批后继续跟踪同一个任务。

## 8. 实现边界

1. 在 `chatcmd.New` 入口明确分流 standalone 与 runtime-client，远端分支不调用 `buildChatSession`。现有独立会话执行逻辑不改成远程代理。
2. 在 `chatcmd` 内增加小范围的 runtime HTTP/WS client 与远端会话控制代码，负责认证、取消、错误解码及请求标识。不提前抽象成全项目通用 SDK。
3. 当前 `runREPL(sess)` 与 `newChatModel(sess)` 直接依赖 `chatSession`，并不是现成的独立 UI 组件。仅提取实际需要的展示数据和事件边界，复用 transcript、composer、Markdown 和活动展示；不构造假的远端 `chatSession`，不提前设计通用执行框架。网络调用异步返回 UI 消息，不能阻塞渲染循环。
4. 复用 `taskdomain` 类型；流式 wire contract 若必须跨包共享，只提取稳定 DTO，不导出 `consoleLocalRuntime` 或把 `consolecmd` 实现导入 TUI。
5. 先做 HTTP 历史与状态闭环，再接 WS 预览。共享 topic 的正确性不依赖流式连接。
6. 更新 `docs` 中 chat 用法、认证配置说明和命令帮助；若实施时新增配置键，同时更新示例配置。

不在本功能中搬迁整个 Console runtime，也不先做大规模统一所有 channel 的 runtime 重构。

### 8.1 兼容与持久化

已有 Web topic/task、`console:<topicID>` 和 checkpoint 不迁移。跨重启持久化受服务端 `tasks.persistence_targets` 配置约束，客户端不覆盖配置，也不另存共享历史来掩盖服务端未启用持久化。standalone 输入历史继续保持原行为，但不作为共享聊天记录的导入来源。

## 9. 实施顺序

正式逻辑先补测试、确认失败原因，再实现并回归；使用 fake runtime、fake LLM 和临时目录，不要求真实 provider 或数据库。文档与简单视觉文案不单独增加测试。

### P1：共享会话闭环

CLI 分流、认证与 Console 检查、`/topics` 独立列表视图、当前服务端 workspace 筛选、方向键选择与 Enter 进入、列表分页、选择/新建、历史分页及 steer 投影、发送、显式停止、退出不停止。同时完成草稿隔离、首次发送前的 workspace 选择及已有话题 workspace 操作、提交操作归属、切换回包隔离、pending/steer 基本状态、当前 topic 持续同步、外部删除处理和 HTTP 断线恢复。

这些是发送与切换的正确性前提，不推迟到展示阶段。此阶段即可从 Web 创建话题并在 TUI 继续，反向亦然。

### P2：话题管理与实时交互

删除确认、标题再生成、WS 帧映射与 HTTP 回退、实时活动展示及窄屏交互完善。WS 只增强预览，不改变 P1 的归属、同步和恢复规则。

### P3：回归与交付

覆盖多客户端、分页、错误恢复和终端交互；补齐使用文档。上述完整验收通过后才将功能标记为 implemented。手动改名不作为第一版隐含依赖。

## 10. 验收与测试

- Web 建话题并发送，TUI 能加载并继续；TUI 新建发送后，Web 刷新能看到同一 ID 与历史。
- 两个 topic 即使使用同一 workspace，也不共享对话上下文；相同 topic 不因客户端 cwd 不同改变 attachment。
- `/topics` 进入独立列表，只显示当前服务端 workspace 的 topics；↑/↓ 只移动选择，Enter 进入选中话题，Esc 返回且保留草稿，列表按键不触发输入历史。
- 多目录、子目录、未绑定目录和客户端 cwd 不同的场景不会混列；首个后端分页无匹配仍能继续找到后续匹配项。空列表、加载失败、刷新后选中项消失均不误入其他话题；从列表新建沿用筛选目录。
- 打开/切换话题不触发 LLM 请求；分页无重复，特殊 topic 的操作限制保持一致。
- A 运行期间切到 B、退出 TUI 或网络断开，A 继续；在 B 执行 `/stop` 不误停 A。
- 快速切换时旧请求回包、旧 WS 帧、删除响应均不会污染当前窗口；切换失败保留原选择和草稿。
- 草稿首次提交后立即切走，成功回包仍绑定原草稿与真实 topic/task，不抢占当前选择、不允许重复创建；后续编辑不被回包清空。
- 新话题首次发送前设置服务端 workspace，首个任务即在该目录执行；无效路径由服务端拒绝，detach 恢复默认语义，客户端 cwd 不参与。
- 当前任务终态后，Web 新增任务、改 workspace 或删除 topic，TUI 仍能发现；刷新间隔内新增多页记录无遗漏，已加载旧历史不丢失。
- steer 实时展示和重载历史一致，跨页缺失目标再补齐时不重复，目标最终回复位于相关追加指令之后。
- 一端压缩上下文后另一端续聊沿用同一 checkpoint，不由客户端重复注入已覆盖消息。
- 双端同时发送、运行中 steer、pending 审批、删除运行中话题均遵循服务端语义。
- WS 断线可轮询获得终态，重连和重复帧不重复显示答案；POST 超时不自动重发。
- 正确处理 token 缺失/错误、runtime 未开放、非 Console endpoint、非默认 base path、404 和服务端 5xx，且日志不泄露 token。
- `mistermorph chat` 不带新参数时保持原有执行和生命周期行为；远端模式不创建本地 agent 或写入本地共享 topic 状态。

测试分层：HTTP/WS client 用测试服务器验证 wire contract；TUI model 测试切换 generation、草稿、确认和取消；Console 集成测试验证两个客户端共享 topic 与任务。终端人工验收覆盖窄屏、输入法、长历史和重连提示。实施时运行受影响 Go 包测试与静态检查。本次仅更新方案，不包含实现或测试执行。
