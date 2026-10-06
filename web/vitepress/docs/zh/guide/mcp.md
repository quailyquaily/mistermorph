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

## 生命周期

1. 读取 `mcp.servers`
2. 连接每个启用、合法且不是 `on_demand` 的 server
3. 拉取工具列表
4. 适配并注册进本地 registry
5. 关闭时清理 MCP session
