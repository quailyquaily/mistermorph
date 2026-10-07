---
title: 用 Console 连接你的程序
description: 让基于 integration 的程序提供运行时 API，再把它加到 Console 里，与它对话并查看它的任务。
---

# 用 Console 连接你的程序

Console 能管理的不只是它自己运行的 Agent：它还能把其他 runtime 当作 **endpoint** 连接，就像连接一个 `mistermorph telegram` 进程一样。基于 `integration` 包写的 Go 程序，只要提供运行时 API，也能成为其中一个 endpoint。

连接后，在 Console 里可以：

- 和你的程序对话。每条消息都由你的 `integration.Runtime` 运行，使用你的工具、prompt block 和 LLM 设置；
- 在对话旁边列出程序自己运行的任务；
- 查看它的模型、LLM 用量、审计日志和日志，并停止正在运行的任务。

## 1. 提供运行时 API

设置 `server.listen` 和 `server.auth_token`，然后调用 `ServeRuntimeAPI`。它会一直运行，直到 context 结束。

```go
package main

import (
  "context"
  "os"
  "os/signal"

  "github.com/quailyquaily/mistermorph/integration"
)

func main() {
  cfg := integration.DefaultConfig()
  cfg.Set("llm.inference_provider", "openai")
  cfg.Set("llm.model", "gpt-5.4")
  cfg.Set("llm.api_key", os.Getenv("OPENAI_API_KEY"))
  cfg.Set("file_state_dir", "./state")

  // Console 连接的运行时 API。
  cfg.Set("server.listen", "127.0.0.1:8790")
  cfg.Set("server.auth_token", os.Getenv("MY_AGENT_TOKEN"))

  rt, err := integration.NewChecked(cfg)
  if err != nil {
    panic(err)
  }

  // 你自己的工具，Console 里的对话也能用。
  reg := rt.NewRegistry()
  _ = reg.Register(&OrderStatusTool{})

  ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
  defer stop()
  if err := rt.ServeRuntimeAPI(ctx, integration.RuntimeAPIOptions{Registry: reg}); err != nil {
    panic(err)
  }
}
```

`OrderStatusTool` 可以是任何实现了 `tools.Tool` 的类型，见 [自定义工具](/zh/guide/build-your-own-agent-advanced)。

API 挂在 `/runtime` 下，所以 endpoint 的地址是 `http://127.0.0.1:8790/runtime`。

## 2. 把 endpoint 加到 Console

在 Console 的 `config.yaml` 里：

```yaml
console:
  endpoints:
    - name: "My Agent"
      url: "http://127.0.0.1:8790/runtime"
      auth_token: "${MY_AGENT_TOKEN}"
```

也可以在 Console 界面里添加：**概览 → 添加 Agent**。endpoint 会带着 `Integration` 标签出现在 Console Local 旁边，打开它就能和你的程序对话。

## 程序自己运行的任务

用 `RunTaskWithOptions` 并设置 `PersistTask: true` 运行的任务，会和对话一起出现在 Console 里。设置 `TopicID` 可以把它们归到同一个话题：

```go
result, err := rt.RunTaskWithOptions(ctx, "检查今天的订单，报告延迟的订单。", integration.RunTaskOptions{
  PersistTask: true,
  TopicID:     "order-reports",
  Registry:    reg,
})
```

运行这些任务时，`ServeRuntimeAPI` 不必正在运行：Console 从 `file_state_dir` 下的任务日志读取它们。

## 对话如何运行

- **历史**：每条消息会带上同一话题之前的对话（最多 20 轮），所以一个话题读起来是一段连续的对话。不指定话题发送的消息会新建一个话题，以消息内容为标题。
- **顺序**：同一话题的消息依次运行，不同话题同时运行。
- **队列**：排队和运行中的任务最多 `server.max_queue` 个，超出的消息会被拒绝，直到有任务结束。
- **超时**：每条消息最多运行 `timeout`，除非 Console 指定了更短的时间。
- **停止**：在 Console 里停止任务会取消它的运行。
- **退出**：context 结束时，`ServeRuntimeAPI` 会取消它启动的对话，并等它们记录下结束状态。因崩溃而没有结束的对话，会在下次启动时标记为已取消。

回答在运行结束后才出现：这个 endpoint 暂时还没有实时进度。Console 的设置编辑、审批、工作区和附件对它也不可用。

## 配置

| 键 | 作用 |
|---|---|
| `server.listen` | 运行时 API 的监听地址。必填。 |
| `server.auth_token` | Console 发送的 Bearer token。必填。 |
| `server.max_queue` | 同时排队或运行的任务上限（默认 100）。 |
| `timeout` | 一条对话消息最长的运行时间（默认 1h）。 |
| `file_state_dir` | 任务、话题、用量和日志的存放位置。每个程序请用各自的目录。 |

## 安全

拿到 token 就能完整使用这个 Agent，包括它的工具。请像上面的例子那样，不要把它写进源码。监听地址请用回环地址；如果 Console 在另一台机器上，请把 API 放在 TLS 反向代理后面。

## 演示

[`demo/embed-console`](https://github.com/quailyquaily/mistermorph/tree/master/demo/embed-console) 是一个完整的程序：一个带自有 `get_order_status` 工具的 Example Shop 客服 Agent，还可以定时运行报告任务。启动时它会打印要粘贴到 Console 配置里的 endpoint 设置。
