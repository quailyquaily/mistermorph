---
title: TUI 与 Web 共享 Topic
date: 2026-09-17
---

# TUI 与 Web 共享 Topic

## 1. 执行约定

`mistermorph chat` 和根命令 `morph` 默认在本进程执行 agent，与 Web Console 共享话题和历史。chat 不发现或启动 Console，不绑定 Web 端口，不要求 `server.auth_token`。用户需要 Web 时单独启动 `morph console`。

只有显式传入 `--runtime-url` 时，chat 才把执行交给指定的 Console runtime。`--standalone` 保留为隐藏的兼容参数，行为与普通 chat 相同。终端始终使用同一个 `chatModel`、输入框、命令菜单、技能菜单、审批面板和历史渲染器。

本地执行允许 `--model`、`--provider`、`--workspace` 等参数。显式远端连接拒绝这些本地执行覆盖参数；远端 workspace 路径由服务端解析，不能拿客户端 cwd 替代。

## 2. 共享存储

chat 与 Console 使用相同的 `file_state_dir`、`tasks.dir_name` 和持久化设置。`tasks.persistence_targets` 包含 `console` 时，两端通过同一 journal 和 ConsoleFileStore 保存 topic/task。关闭该持久化目标后，不保证跨进程或跨重启共享，chat 不覆盖用户配置。

沿用现有 topic ID、task 格式、workspace attachment 和 `console:<topicID>` conversation key，不创建另一份聊天数据库。模型历史由同一组 task 转换函数构造；压缩 checkpoint 的消息边界也保持一致。每次本地发送前重新读取历史，纳入 Web 新增的消息，并按 checkpoint 排除已经覆盖的部分。

ConsoleFileStore 的每次读写先获得进程间文件锁，再重放其他进程追加的 journal，之后读取或修改状态。单独锁住 append 不够：旧的内存投影可能覆盖其他写入或错误推进 cursor。话题创建、重命名、删除和任务更新都遵循相同顺序。

本地 chat 打开 store 时跳过 Console 的启动恢复。每个 chat 会话持有一个生命周期锁，任务 trigger 保存该会话标识。Console 恢复时保留锁仍被持有的本地任务；后续 store 访问也会把已退出 chat 的未完成任务标为 canceled。会话锁在任务退出和待审批状态清理后才释放。

`stats/topics_projection.json` 继续作为派生列表缓存。它不含完整历史或 checkpoint；本地 `/topics` 直接读取共享 store，不依赖缓存是否存在。

## 3. 话题与历史

启动直接显示输入框，不自动打开话题列表。新草稿不立即创建 topic，第一条消息才创建。`--topic <id>` 和 `/topic switch <id>` 验证话题并恢复历史；失败保留当前话题。

`/topics` 打开当前 workspace 的话题选择器。目录按规范路径精确匹配，不把子目录或其他目录的话题混入列表。无 workspace 时显示未绑定分组。跨目录话题仍可用完整 ID 显式选择。

选择器支持方向键、Enter、Esc、标题或 ID 筛选，以及 New topic / Load more 动作行。Ctrl+N 新建，Ctrl+L 翻页，Ctrl+R 刷新，Ctrl+S 查看目录信息。筛选仅作用于已加载内容。

历史使用正常聊天样式：用户消息显示 `❯`，回复按 Markdown 渲染，不在正文中插入 task ID 或 `done`。错误、取消、待审批提示单独展示。steer 消息关联原任务，不能把“追加指令已接收”当作该任务的最终答案。

本地选择话题或执行 `/topic history` 时重新读取记录；`/topic history more` 加载旧记录。发送前再次读取共享历史。终端输入历史仅用于上下键召回，不是模型上下文，也不导入为共享聊天记录。

## 4. 命令和生命周期

| 操作 | 本地执行 | 显式远端连接 |
| --- | --- | --- |
| `/topic new`、`/topic switch <id>` | 当前任务结束后切换 | 切换视图，原服务端任务继续 |
| `/topic history [more]` | 读取共享 store | 读取 runtime API |
| `/workspace attach <dir>`、`detach` | 更新本地目录及共享 attachment；detach 回到默认目录 | 在服务端更新 attachment |
| `/topic title regenerate` | 本地调用模型，按标题 revision 保存结果 | 调用服务端生成接口 |
| `/topic delete` | 确认后删除；拒绝删除正在执行的话题 | 确认后调用删除接口；不能删除其他本地进程正在执行的话题 |
| `/models`、`/skills`、`/think`、`/ctx` | 使用本地 runtime | 使用远端 runtime |
| `/reset` | 保存 reset 边界并清理共享 checkpoint，保留可见历史 | 服务端按话题顺序执行 |
| `/init`、`/update` | 在本地 workspace 读写 AGENTS.md | 在服务端 workspace 执行 |
| `/approve`、`/deny` | 在拥有任务的终端审批和续跑 | 通过 Console 审批接口处理 |
| `/stop`、运行时 Esc/Ctrl+C | 停止当前本地任务并保存取消结果 | 请求停止当前话题的服务端任务 |
| `/exit`、`/quit` | 等待本地任务取消并保存结果，清理待审批任务 | 退出客户端，服务端任务继续 |
| `/agents`、`/agent`、`/subagents` | 查看本地执行或已保存的子任务记录 | 查看远端执行记录 |

同一话题不能同时由 chat 和 Console 执行。任务提交在存储锁内检查：另一执行方仍有 queued、running 或 pending 任务时，返回忙碌错误。不同话题可以并行。当前 chat 内输入追加指令仍进入原有 steer queue，并保存关联记录；Console 内的排队和 steer 行为保留。

本地运行或审批期间允许查看话题列表、状态和子任务，但切换话题、重置上下文或改 workspace 必须等任务结束。停止和审批由持有执行状态的进程处理，不通过改写另一个进程的任务状态假装完成操作。

## 5. 终端界面

所有终端聊天共用原输入框、上下边框、动态高度、命令高亮、粘贴折叠和输入历史。`/` 打开命令菜单，`$` 打开技能菜单。方向键选择，Tab 补全，Esc 关闭；Enter 执行命令或插入技能引用。远端技能来自目标 runtime，本地技能来自本地配置。

任务运行时显示 Running、spinner、耗时和当前工具或计划步骤。输入框下面保留模型、workspace、话题及已知上下文占比。成功或失败后清理进度，状态栏继续显示。窄屏优先保留输入框和状态，避免把进度写入普通聊天正文。

执行记录保留工具参数和输出、计划、文件差异、重试和子任务事件。chat 与 Console 使用同一有界 trace collector，并在任务完成或待审批时保存。重新打开话题恢复已保存的记录；旧任务从 plan/activity 恢复已有信息，不补造未保存的细节。记录上限见 [终端聊天文档](../chat.md#inspect-subagents)。

## 6. 显式远端连接

`--runtime-url` 必须是完整 runtime API base URL，可包含反向代理前缀。非 loopback 地址要求 HTTPS。只读取 `MISTERMORPH_RUNTIME_TOKEN`，不把本地配置 token 或自动生成的控制凭据发送到指定地址，不提供命令行明文 token 参数，不跟随重定向。

连接先检查 `/health`，确认 `mode: console`，再请求受保护的话题接口。连接失败直接报错，不改为本地执行。公共 runtime API 仍要求 Console 配置 `server.auth_token`。

HTTP 轮询是远端状态来源，正常间隔 3 秒，失败退避到 30 秒。WebSocket 为当前话题最多四个活动任务提供进度预览；其他任务继续 HTTP 跟踪。订阅失败不停止轮询，终态替换预览，序号去重避免重复正文和工具记录。切换后忽略旧请求回包，退出时关闭订阅。

远端草稿按话题保留到客户端退出。首次提交结果未知时不自动重试，用户通过 `/topics` 和历史核实，避免重复创建 topic。删除必须确认；其他客户端删除当前话题后禁用发送。标题生成用 revision 检测并发修改，不自动重复调用模型。

## 7. 代码边界与验证

- `chatcmd/chat.go`、`connection.go`：默认本地执行，显式 URL 才构造远端 client。
- `chatcmd/local_topics.go`、`topics.go`：本地会话 ownership、共享任务写入、话题操作与历史读取。
- `chatcmd/repl.go`：沿用本地执行、steer、停止和审批生命周期，保存共享结果。
- `chatcmd/bubble.go`、`local_topics_ui.go`、`remote*.go`：一个 UI model；本地与远端数据交给共同的选择器和历史渲染器。
- `internal/daemonruntime/console_store*.go`：跨进程刷新、写入互斥、任务冲突和退出恢复。
- `internal/chathistory/tasks.go`、`internal/chattrace/collector.go`：两端共用的消息边界和执行记录。

验证覆盖：无 Console 的本地模型调用；被占用的 Web 端口不影响 chat；chat 和 Web 互读历史；下一轮模型请求包含两端消息；共享 workspace；话题选择、标题和删除确认；reset 边界；steer 保存；并发记录不丢失；启动 Console 不取消活跃 chat；chat 退出后恢复未完成任务。保留原有命令菜单、技能菜单、Running、状态栏、历史、审批、子任务及远端 HTTP/WS/PTY 回归。

使用方式见 [终端聊天](../chat.md) 和 [Console 文档](../console.md#shared-topics-in-the-terminal)。
