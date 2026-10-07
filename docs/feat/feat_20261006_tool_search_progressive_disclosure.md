---
date: 2026-10-06
title: "Tool search and progressive disclosure"
status: implemented-v1
---

# Tool search and progressive disclosure

## Goal

Let the model find MCP tools when it needs them, instead of sending every MCP tool's description and parameter schema in every request. One connected server can bring hundreds of tools; a task usually needs two.

The first version uses an ordinary `tool_search` function tool and the existing `llm.Client.Chat` interface, so it works with every provider that supports the current tool loop, including tool emulation. Provider-native discovery protocols are not required.

This is separate from [dynamic MCP loading](feat_20261006_dynamic_mcp_loading.md). Dynamic loading decides when to connect a server. Progressive disclosure decides which of its tools the model sees.

## Current behavior

- `tools.Registry` holds every executable tool for a run: built-in and runtime tools, engine tools (`spawn`, `acp_spawn`, `coder`, registered by `registerEngineTools`), tools supplied by embedders, and MCP tools.
- The engine builds the model's tool list once, from the whole registry, at the start of `Run` and `Resume` (`buildLLMTools(e.registry)` in `agent/engine.go` and `agent/engine_resume.go`).
- `agent/prompt_template.go` also lists every registered tool's summary in the system prompt, so hiding schemas alone would leave the full directory in context.
- An unknown tool call gets an error listing every registered tool name (`agent/engine_loop.go`).
- MCP servers with `enable: true` connect at startup unless `on_demand: true`. `$mcp_<name>` connects an enabled server for one task and registers all its allowed tools. `enable: false` means off.
- Skills loaded in a conversation stay loaded for its later turns (`RunRequest.StickySkills`, `RunResult.LoadedSkills`; channels keep them per conversation).

## Scope

When tool search is enabled:

- Built-in, runtime, engine and embedder tools stay visible exactly as today.
- MCP tools are hidden until the model finds them with `tool_search`, except those loaded by a `$mcp_<name>` reference.
- A found tool stays visible for the rest of the conversation.

Search makes tools visible; it does not run them, and it is not authorization (see "Policy"). Skills keep their existing discovery and loading. This feature does not search skills.

## Configuration

```yaml
tools:
  tool_search:
    enabled: true

mcp:
  servers:
    - name: github-work
      description: "Search repositories and read issues in the work GitHub account."
      enable: true
      on_demand: true
      type: http
      url: "https://mcp.example.com/mcp"
      allowed_tools: [search_repositories, get_issue]
```

- `tool_search.enabled` turns the feature on. On by default; with it off, nothing changes. Embedders using `integration` keep it off unless they enable it.
- An `always_loaded` list of MCP tools visible from the first request was implemented in v1 and removed on 2026-10-07: a tool the conversation uses stays visible anyway, and `$mcp_<name>` loads a server's tools for a task.
- `description` is an optional MCP server field, used to find a server before connecting it. Without it the server is found by name only. Never connect a server just to read its description. Commands, URLs, environment variables and headers are never search metadata.

`tool_search` is offered to the model only when something is hidden: a connected server's tools that are not visible, or an enabled on-demand server. With no MCP servers configured, enabling the feature changes nothing.

A registered tool named `tool_search` (for example from an embedder) conflicts with the feature: preparation fails with an error naming it, rather than replacing either tool.

Document the setting in `assets/config/config.example.yaml`. The Console settings expose the switch, and the MCP server dialog edits `description` next to "Load on demand". Standalone and Console-managed runtimes read the same settings.

## What the model can find

| Capability | With tool search enabled |
| --- | --- |
| Built-in, runtime, engine, embedder tool | Visible as today; not part of search |
| Tool of a server connected at startup | Hidden; found by name or description |
| Enabled on-demand server | Found by server name and description, without connecting |
| Enabled server whose startup connection failed | Found as a server; a scoped search retries it |
| Server with `enable: false`, invalid, or with a duplicated name | Absent; search cannot connect it |
| Tool excluded by `allowed_tools` | Absent; an exact-name search cannot reach it |

Enabling tool search extends on-demand behavior on purpose: the model may connect an enabled server through a scoped search, without a `$mcp_<name>` reference.

### Explicit references

References keep their meaning and precedence from dynamic MCP loading:

- `$mcp_<name>` connects the server when needed and makes all its allowed tools visible before the first request. A failure still fails preparation.
- `$tool_name` and skill references behave as today.
- References are still read from the user's own text, never from quoted messages or steering.

## Search interface

One function tool:

```json
{ "query": "find an issue in github", "server": "github-work", "limit": 5 }
```

| Argument | Contract |
| --- | --- |
| `query` | Required, nonempty: an exact tool name or words describing the task |
| `server` | Optional configured server name (matched ignoring case). Restricts the search to that server and connects it if needed |
| `limit` | Optional, default 5, range 1–10; bounds the combined number of tool and server results |

- **Without `server`:** searches the hidden tools of connected servers, and the names and descriptions of enabled servers. It never opens a connection. A server result means "this server may help"; it is not a claim that a particular tool exists.
- **With `server`:** connects only that server if this run does not already have it, applies `allowed_tools`, and searches its tools. Only matching tools are returned, at most `limit`, never every tool of the server. No wildcard and no fan-out across servers.

Matching tools become visible on the next request. Servers are never connected by a search without `server`. The result is small JSON, without parameter schemas (those arrive in the next request's `Tools`):

```json
{
  "tools": [
    { "name": "mcp_github-work__get_issue", "description": "Get an issue.", "server": "github-work", "already_visible": false }
  ],
  "servers": [
    { "name": "github-work", "description": "Search repositories and read issues in the work GitHub account.", "connected": false }
  ],
  "has_more": false
}
```

`already_visible` reports whether the tool was visible before this search; repeated searches add nothing twice. `has_more` means `limit` cut results; the model can refine the query. Descriptions may be shortened; names are always complete. A server result tells the model to search again with `server`.

### Matching

Local and deterministic, over tool names, tool descriptions, and server names and descriptions. Exact tool names rank first, then name prefixes, then text matches; ties break by name. Case is ignored and identifier separators split words, so `get_issue` matches `get issue`. Unicode text is matched without being altered. No semantic or cross-language retrieval, embeddings, or reranking in the first version; the instructions suggest retrying with likely tool names or in the descriptions' language.

No match returns an empty result, never every tool. Invalid arguments and unreachable servers return a tool error with a short reason and whether retrying may help.

## Model interaction

The system prompt says that more tools can be found with `tool_search`, that a server result needs a scoped search, and that found tools can be called from the next step. Hidden tools appear nowhere in the prompt: not in tool summaries, examples, or the unknown-tool error, which lists visible tools only and points to `tool_search`.

```text
User: Find the issue about login failures in the work repository.

Step 1: tool_search(query="github repository issue")
        → server github-work (not connected)
Step 2: tool_search(server="github-work", query="get issue")
        → mcp_github-work__get_issue; server connected
        Next request includes its schema.
Step 3: mcp_github-work__get_issue(...)
        → run by the existing MCP adapter, guard and approval flow.

Next message in the same chat: mcp_github-work__get_issue is visible from the first request.
```

The system prompt is built once per run and does not change after a search; found tools are added only to `Request.Tools`.

### Prompt-cache cost

Providers put tool definitions before the system prompt (see "Request layout" in `docs/prompt.md`). So each request that adds a newly found tool changes the start of the cached prompt, and that request sends the system prompt and history uncached. Keeping found tools for the conversation limits this to the turn where a tool is first found; later turns start with the same tools. The benchmark records cached and uncached input tokens, not only schema bytes.

## Engine and runtime

### Where the code lives

- `agent` owns visibility: the visible set, each request's tool list, the check that a called tool was visible in the request that called it, and the run state. It uses a small catalog interface with two calls, search and make-visible-by-name. `agent` does not import MCP code.
- `taskruntime` implements the catalog: it searches the run's registry and the MCP server statuses, and connects a server for a scoped search under the run's existing cleanup, the same path `$mcp_<name>` uses (`mcphost.ConnectServers`, 30-second timeout, abort on deadline).

### Visibility during a run

- Each request is built from the visible set, not a list frozen at the start of the run.
- A call to a hidden tool fails with an error pointing to `tool_search`; it does not run.
- Newly found tools become visible after the current batch of tool calls finishes. If one response both searches and calls a tool that was hidden, that call is rejected for this step.
- Parallel searches merge their additions without duplicates, races, or a second connection to the same server; the order stays deterministic.
- A run can make at most 20 tools visible through search. A search beyond that returns an error asking the model to work with the tools it has.
- Context accounting and compaction count the current tool schemas. Compaction keeps the visible set, since it is run state, not something read back from messages.

### Conversation lifetime

Found tools follow loaded skills:

- A run receives the conversation's earlier finds as `RunRequest.StickyTools` and returns its own finds in `RunResult`, next to `LoadedSkills`.
- Channels store them where they store sticky skills, per conversation, in memory. The Console stores them in the topic's state folder (`topics/<topic>/`), so they survive a restart.
- At most 20 per conversation, keeping the most recently used. `/reset` clears them with sticky skills.
- A sticky tool whose server is not connected makes preparation connect that server, showing only the sticky tools, not all its tools. If that fails, the tool is dropped for the turn with a log line and the task still runs: unlike `$mcp_<name>`, the user did not ask for that server in this message.
- A sticky tool that no longer exists, or is no longer allowed, is dropped silently.

### MCP connections and errors

Servers connected at startup stay owned by the runtime. Servers connected by a scoped search or for a sticky tool belong to the run and close when it returns, including on cancellation and approval pause.

A failed scoped search returns a tool error and leaves the visible set unchanged; no partial set of tools is published. A failed server is not retried by unrelated searches; a later scoped search may retry it.

Search never changes the shared registry or saved configuration. Two concurrent tasks can see different tools from the same server.

### Approvals and resume

Add the visible tool names to the run's existing `resume_state`. Resume reconnects the servers they need, checks current permissions, restores the visible set, and continues with the approved call. It does not repeat searches. Records saved before this change resume as today. Server-side MCP session state is not restored, as in dynamic MCP loading.

### Entry points

Integrate through `taskruntime.prepareRun`, the engine, and the awareness runner, so CLI, Console, standalone and Console-managed channels, cron, TODO, heartbeat and agent handoffs behave alike. The decision-route checks (group check, lightweight pre-check) do not use tools.

Subtasks keep their restrictions, including `DisableRuntimeTools`; a subtask does not inherit its parent's found tools. Embedders keep their current behavior unless they enable the feature. Native function calling and tool emulation use the same visible set; a retry or provider fallback keeps it.

## Policy and observability

Search is not authorization. `allowed_tools`, credentials, sandbox rules, guard checks and action approvals still govern execution. Tool descriptions and schemas are untrusted data and cannot widen permissions.

Log search duration, match counts, newly visible tool names, connection outcomes, and per request the visible tool count and schema bytes. Queries, schemas, credentials and full descriptions stay out of info logs. Request dumps show which schemas each request carried.

## Implementation notes (v1)

- `agent/tool_search.go` holds the engine side: `ToolCatalog`, `ToolSearchOptions` / `WithToolSearch`, the per-run visible set, the `tool_search` tool, and ranking. Found tools wait in a queue during a step and are registered and made visible after the batch, so the registry is never changed while tool calls run in parallel. `Hidden` decides what starts hidden; the runtime passes `mcphost.IsTool`.
- `taskruntime.ToolSearchOption` builds the option and a `runToolCatalog` per run, for `prepareRun` and the awareness runner. It returns no option when nothing would be hidden, and a preparation error when another tool is named `tool_search`.
- Found tools are saved per conversation in the topic's state folder (`topics/<topic>/found_tools.json`, via `contextcheckpoint`) for every chat entry point, keyed by the conversation key already in the run's context. This replaces the in-memory store the design planned for channels: one store, no per-channel plumbing, and it survives restarts. `contextcheckpoint.Reset` clears it, so every `/reset` path forgets found tools. CLI `run`, heartbeat and cron have no conversation and keep nothing.
- `resume_state` gains `visible_tools` and `found_tools`; resume restores them through the catalog (`LoadTools`).
- Subtasks never receive hidden tools or `tool_search` (`Engine.lookupSubtaskTool`), found or not.
- Context accounting needed no change: compaction uses the provider-reported input tokens, which include the request's tool schemas.
- The `[[ Tool Search ]]` block names the searchable servers with their descriptions (up to 20), never tool names. Without it, a real model with tool_search available answered "unknown" instead of searching; with it, the model searched globally, then within the server, and called the found tool.
- Not done yet: the large-catalog benchmark and recorded discovery traces.

## Acceptance criteria

| Case | Expected result |
| --- | --- |
| Feature off | Tool lists, prompts, references, connection timing, execution and the unknown-tool error are unchanged |
| No MCP configured | `tool_search` is not offered; nothing changes |
| Large MCP catalog | The first request has the built-in tools, `tool_search` and `$mcp_` references' tools; no hidden tool in the prompt |
| Search finds three tools | Exactly those three schemas appear in the next request, not in the result text |
| Repeated or exact-name search | Stable ranking, no duplicates; exact allowed names are found |
| No match or invalid query | Empty result or argument error; nothing made visible in bulk |
| Search matches an on-demand server | Server returned without connecting |
| Scoped search | Connects only that server, applies `allowed_tools`, returns at most `limit` matching tools |
| Disabled or excluded tool | Absent; a guessed call fails and points to `tool_search` |
| Search and call in one response | The call to the newly found tool is rejected for that step |
| Next message in the chat | Previously found tools are visible from the first request; `/reset` clears them |
| Sticky tool's server unreachable | The tool is dropped for the turn; the task runs |
| Visible-tool cap | The 21st found tool is refused with an error; earlier ones stay |
| Parallel searches, concurrent tasks | Deterministic additions, one connection per server per run, no shared state |
| Timeout, cancellation, collision | Clear error, nothing partial published, run-owned connections closed |
| Compaction | Schemas counted; visible set kept |
| Approval pause and resume | Visible set restored under current policy |
| Retry, emulation, fallback | Same visible set; hidden schemas never sent |
| Entry points | Same behavior everywhere; subtasks and decision checks unchanged |

Use fake model clients, local fake tools and local MCP servers; no credentials or external services. Include a benchmark over a fixed large MCP catalog recording schema bytes, cached and uncached input tokens, search latency and model steps, and traces of a successful discovery and of recovery from a failed search.

## Implementation sequence

Add each phase's tests first and run them before changing production code. Keep the feature off by default until search, execution and approval resume work together; v1 turned it on by default once they did.

1. **Catalog and search:** configuration, MCP `description`, the catalog interface, deterministic matching, limits.
2. **Engine visibility:** initial visible set, per-request tool lists, hidden-call errors, step timing, the cap, compaction, `resume_state`.
3. **MCP discovery:** server results, scoped connections, `allowed_tools`, run ownership, timeout and cleanup.
4. **Conversation lifetime and integration:** sticky tools in channels and the Console, all entry points, Console settings, emulation checks, request dumps, benchmark, configuration docs.

## Outside the first version

- Hiding built-in, runtime, engine or embedder tools.
- Installing servers or changing saved configuration from search.
- Searching a marketplace or unconfigured servers.
- MCP resources, prompts, or skill bodies through `tool_search`.
- Sharing connections across tasks, or a persistent search index.
- Semantic retrieval, embeddings, learned ranking, or searching all servers at once.
- Removing found tools during a conversation, other than the cap and `/reset`.
- Provider-native tool search; it can come later as an adapter with the same rules.
