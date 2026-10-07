---
title: MCP
description: 配置 MCP，并接入本地 Agent 工具循环。
---

# MCP

Mister Morph 可连接 MCP，并把 MCP 提供的工具注册到同一个 tool-calling 循环中。

## 工具名映射

MCP 工具会被注册为：`mcp_<server_name>__<tool_name>`

例如：`mcp_example__read_file`

## 支持的传输类型

- `stdio`（默认）
- `http`

## 配置

```yaml
mcp:
  servers:
    - name: example_cmd
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/example_cmd", "/tmp"]
      allowed_tools: []

    - name: remote
      type: http
      url: "https://mcp.example.com/mcp"
      headers:
        Authorization: "Bearer ${MCP_REMOTE_TOKEN}"
      allowed_tools: ["search"]
```

其中：

- `name`：必须符合 `[A-Za-z][A-Za-z0-9_-]*`，以英文字母开头，后续只允许英文字母、数字、下划线和连字符。不允许空格，包括首尾空格；未启用的条目也遵循此规则。
- `enable`: 可禁用或者启用某个 server。禁用的 server 处于关闭状态，不会被连接。
- `on_demand`：为 `true` 时，启用的 server 在启动时不连接；任务中写 `$mcp_<name>` 时才加载（见下文）。
- `allowed_tools`：表示该 server 可以使用的其他工具，留空为不限制

名称在忽略大小写后也必须唯一：`GitHub` 和 `github` 冲突，启动时两个条目都会被跳过。

## 为单个任务加载 server

给 server 设置 `on_demand: true`，然后在任务中写 `$mcp_<name>`：

```yaml
mcp:
  servers:
    - name: github-work
      on_demand: true
      type: http
      url: "https://mcp.example.com/mcp"
      allowed_tools: ["search_repositories", "get_issue"]
```

```text
$mcp_github-work 找到描述这个 bug 的 issue。
```

- server 只为该任务连接，在向模型发出第一个请求之前完成；它的工具（如 `mcp_github-work__get_issue`）在整个任务中可用，任务结束时连接关闭。
- 名称匹配忽略大小写。若有同名技能（`mcp_github-work`），技能优先。
- 可用于聊天消息、Console 聊天、CLI 任务、cron 和 TODO 任务、heartbeat，以及来自其他 Agent 的交接。Telegram 引用消息中的 `$mcp_` 会被忽略。
- 启动时已连接的 server 无需引用。启动时连接失败的 server，会在引用它的任务中重新尝试连接。
- 若 30 秒内无法连接，或没有允许的工具，任务会失败，错误信息中包含 server 名称。

## 工具搜索

MCP 工具很多时，每个请求都会带上全部工具定义。工具搜索（默认开启）会隐藏 MCP 工具，直到模型需要时才出现：

```yaml
tools:
  tool_search:
    enabled: true       # 默认值；设为 false 则每个请求都带上全部 MCP 工具
```

只有存在可查找的内容（MCP 工具，或启用的 on-demand server）时才会提供 `tool_search`。没有 MCP 时请求不变。

- 内置工具始终可见。MCP 工具被隐藏，模型通过 `tool_search` 工具按名称或描述找到它们。
- 搜索时可以指定 server（`server`），这会为该任务连接一个启用的 on-demand server 并搜索它的工具。给 server 加上 `description`，便于在连接前被找到。
- 找到的工具从下一步起可以调用，并在整个会话中保持可见；`/reset` 会清除。
- `$mcp_<name>` 仍会从第一个请求起显示该 server 允许的全部工具。

## 生命周期

1. 读取 `mcp.servers`
2. 连接每个启用、合法且不是 `on_demand` 的 server
3. 拉取工具列表
4. 适配并注册进本地 registry
5. 关闭时清理 MCP session
