---
title: MCP
description: Configure MCP and expose MCP tools in the local agent loop.
---

# MCP

Mister Morph can connect to MCP and register MCP-provided tools into the same tool-calling loop.

## Tool Name Mapping

MCP tools are registered as: `mcp_<server_name>__<tool_name>`

Example: `mcp_example__read_file`

## Supported Transports

- `stdio` (default)
- `http`

## Configuration

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

Where:

- `name`: must match `[A-Za-z][A-Za-z0-9_-]*`: start with an ASCII letter, followed by letters, digits, underscores or hyphens. Spaces are not allowed, including at the start or end. This also applies to disabled entries.
- `enable`: enables or disables a server entry. A disabled server is off: it is never connected.
- `on_demand`: when `true`, an enabled server is not connected at startup; a task loads it by writing `$mcp_<name>` (see below).
- `allowed_tools`: limits which tools from that server are usable; leave it empty for no restriction

Names must also be unique ignoring case: `GitHub` and `github` conflict, and both entries are skipped at startup.

## Loading a Server for One Task

Mark a server `on_demand: true`, then write `$mcp_<name>` in a task:

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
$mcp_github-work Find the issue that describes this bug.
```

- The server is connected for that task only, before the model's first request, and its tools (`mcp_github-work__get_issue`, ...) are available for the whole task. The connection closes when the task ends.
- Names match ignoring case. A skill of the same name (`mcp_github-work`) takes precedence.
- References work in chat messages, Console chat, CLI tasks, cron and TODO tasks, heartbeats, and handoffs from other Agents. A `$mcp_` inside a quoted Telegram message is ignored.
- A server connected at startup needs no reference. One that failed to connect at startup is retried for a task that references it.
- If the server cannot be connected within 30 seconds, or has no allowed tools, the task fails with an error naming the server.

## Tool Search

With many MCP tools, every request would carry all of their definitions. Tool search, on by default, hides MCP tools until the model asks for them:

```yaml
tools:
  tool_search:
    enabled: true       # default; false sends every MCP tool with every request
    always_loaded: []   # MCP tool names to keep visible
```

`tool_search` is offered only when there is something to find: MCP tools, or an enabled on-demand server. Without MCP, requests are unchanged.

- Built-in tools stay visible. MCP tools are hidden, and the model finds them with the `tool_search` tool by name or description.
- A search can name a server (`server`), which connects an enabled on-demand server for that task and searches its tools. Give servers a `description` so they can be found before connecting.
- A found tool can be called from the next step, and stays visible for the rest of the conversation. `/reset` forgets it.
- `$mcp_<name>` still makes all of that server's allowed tools visible from the first request.

## Lifecycle

1. Runtime reads `mcp.servers`.
2. Connect to each enabled, valid server that is not `on_demand`.
3. List server tools.
4. Adapt and register tools into local registry.
5. On shutdown, close MCP sessions.
