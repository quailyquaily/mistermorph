---
title: Connect a Console to Your Program
description: Serve the runtime API from a program built on integration, and add it to a Console to chat with it and watch its tasks.
---

# Connect a Console to Your Program

A Console can manage more than the agent it runs itself: it connects to other runtimes as **endpoints**, the way it connects to a `mistermorph telegram` process. A Go program built on the `integration` package becomes one of those endpoints when it serves the runtime API.

Once connected, the Console can:

- chat with your program. Each message runs through your `integration.Runtime`, with your tools, prompt blocks and LLM settings;
- list the tasks your program runs itself, next to the chats;
- show its model, LLM usage, audit log and logs, and stop a running task.

## 1. Serve the runtime API

Set `server.listen` and `server.auth_token`, then call `ServeRuntimeAPI`. It blocks until the context ends.

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

  // The runtime API the Console connects to.
  cfg.Set("server.listen", "127.0.0.1:8790")
  cfg.Set("server.auth_token", os.Getenv("MY_AGENT_TOKEN"))

  rt, err := integration.NewChecked(cfg)
  if err != nil {
    panic(err)
  }

  // Your own tools, available to the Console's chats.
  reg := rt.NewRegistry()
  _ = reg.Register(&OrderStatusTool{})

  ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
  defer stop()
  if err := rt.ServeRuntimeAPI(ctx, integration.RuntimeAPIOptions{Registry: reg}); err != nil {
    panic(err)
  }
}
```

`OrderStatusTool` is any type that implements `tools.Tool`; see [Custom Tools](/guide/build-your-own-agent-advanced#custom-tools).

The API is served under `/runtime`, so the endpoint URL is `http://127.0.0.1:8790/runtime`.

## 2. Add the endpoint to a Console

In the Console's `config.yaml`:

```yaml
console:
  endpoints:
    - name: "My Agent"
      url: "http://127.0.0.1:8790/runtime"
      auth_token: "${MY_AGENT_TOKEN}"
```

You can also add it from the Console: **Overview → Add Agent**. The endpoint then appears next to Console Local, with the `Integration` label. Open it to chat with your program.

## Tasks your program runs itself

Run them with `RunTaskWithOptions` and `PersistTask: true`, and they appear in the Console with the chats. A `TopicID` groups them in one topic:

```go
result, err := rt.RunTaskWithOptions(ctx, "Check today's orders and report any that are late.", integration.RunTaskOptions{
  PersistTask: true,
  TopicID:     "order-reports",
  Registry:    reg,
})
```

`ServeRuntimeAPI` doesn't have to be running when these tasks run; the Console reads them from the task journal under `file_state_dir`.

## How chats run

- **History.** Each message carries the earlier exchanges of its topic (up to 20), so a topic reads as one conversation. A message sent without a topic starts a new one, titled after the message.
- **Order.** Messages in one topic run one after another; different topics run at the same time.
- **Queue.** At most `server.max_queue` tasks are queued or running; further messages are refused until one finishes.
- **Timeout.** Each message runs for at most `timeout`, unless the Console sends a shorter one.
- **Stop.** Stopping a task in the Console cancels its run.
- **Shutdown.** When the context ends, `ServeRuntimeAPI` cancels the chats it started and waits for them to record how they ended. Chats left unfinished by a crash are marked canceled at the next start.

Answers appear when the run finishes: the Console shows no live progress for this endpoint yet. The Console's settings editor, approvals, workspaces and attached files are not available for it either.

## Configuration

| Key | Role |
|---|---|
| `server.listen` | Address the runtime API listens on. Required. |
| `server.auth_token` | Bearer token the Console sends. Required. |
| `server.max_queue` | Most tasks queued or running at once (default 100). |
| `timeout` | Longest a chat message runs (default 1h). |
| `file_state_dir` | Where tasks, topics, usage and logs are kept. Give each program its own. |

## Security

The token gives full use of the agent, including its tools. Keep it out of your source, as above. Listen on a loopback address, or put the API behind a TLS reverse proxy if the Console runs on another machine.

## Demo

[`demo/embed-console`](https://github.com/quailyquaily/mistermorph/tree/master/demo/embed-console) is a complete program: an Example Shop support agent with its own `get_order_status` tool, and an optional scheduled report task. It prints the endpoint block to paste into the Console's config.
