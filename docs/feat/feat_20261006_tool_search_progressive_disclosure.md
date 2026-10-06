---
date: 2026-10-06
title: "Tool search and progressive disclosure"
status: draft
---

# Tool search and progressive disclosure

## Goal

Let the model find tools when it needs them, without sending every tool description and parameter schema in every request. Cover built-in tools, runtime tools, tools supplied by embedders, and MCP tools through one search interface.

The first version uses an ordinary `tool_search` function tool and the existing `llm.Client.Chat` interface. It must work across providers that support the current tool loop, including tool emulation. Provider-specific discovery protocols are not required.

This is separate from [dynamic MCP loading](feat_20261006_dynamic_mcp_loading.md). Dynamic loading decides when to connect a server. Progressive disclosure decides which of its tools the model sees. A connected server may have hundreds of tools while only two are disclosed to a task.

## Current behavior

- `tools.Registry` holds executable tools. The engine builds the model's complete tool list from that registry at the start of `Run` and `Resume`.
- `agent/prompt_template.go` also includes registry tool summaries in the system prompt. Hiding schemas alone would leave the full tool directory in context.
- Enabled MCP servers connect at startup unless `on_demand: true`. An explicit `$mcp_<name>` reference connects an enabled server for the task when needed and registers all its allowed tools.
- Built-in `$name` references can opt a tool into a task even when it is not enabled by default. MCP `enable: false` means off and cannot be overridden by a reference.

As the registry grows, unrelated tool definitions consume input tokens and make tool selection harder. Requiring users to know every tool or server name also limits the value of on-demand loading.

## Required behavior

1. Start a task with a small set of disclosed tools and `tool_search`.
2. Search the task's permitted tool catalog by name and description.
3. Disclose matching tools by adding their complete schemas to the next model request.
4. Let the model invoke those tools through the existing executor, guard, and approval flow.
5. Discover configured on-demand MCP servers without connecting all of them.
6. Keep disclosure and task-owned connections isolated between tasks.
7. Preserve current behavior when this feature is disabled.

Search loads definitions; it does not execute the tools it finds. Skills keep their existing discovery and loading behavior. This feature does not search or load skill bodies.

## Configuration

Add an opt-in setting:

```yaml
tools:
  tool_search:
    enabled: false
    always_loaded: [read_file]
```

When enabled, `tool_search` is always disclosed. `always_loaded` contains exact registered tool names whose schemas should also be disclosed before the first request. Its default is `[read_file]`; an explicit empty list is valid. Entries do not grant permission or connect a server. An unavailable entry is skipped with a diagnostic naming it.

Other tools that are eligible for the task are deferred. There is no automatic tool-count threshold in the first version. Duplicate entries are ignored. A registered custom tool named `tool_search` conflicts with the feature and must produce a clear preparation error rather than replacing either tool.

Add an optional description to MCP server configuration:

```yaml
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

The description helps find a server before connecting to it. An omitted description leaves the server searchable by name. Do not connect merely to obtain a description. Do not expose transport commands, URLs, environment variables, or headers as search metadata.

Document these settings in `assets/config/config.example.yaml`. Console settings must preserve them when saving, expose the search switch and initial tool list, and allow editing the MCP description. Use the same configuration in standalone runtimes and Console-managed runtimes.

## Eligibility, connection, and disclosure

Keep three facts distinct:

| Fact | Meaning |
| --- | --- |
| Eligible | Existing task and host rules permit the capability to be made available |
| Connected | An MCP session exists and its allowed tool metadata has been obtained |
| Disclosed | The complete tool schema is available to the model for the current step |

For local tools, the catalog contains tools that would otherwise be registered for this task. It does not become a second mechanism for opting in disabled built-ins. Existing explicit references may make such a tool eligible before search begins.

For MCP, only configured, enabled servers are discoverable. Apply `allowed_tools` before indexing or returning tool metadata. Invalid or ambiguous server configurations cannot be connected through search. A server with no allowed tools cannot contribute any tools.

| Capability | Behavior with search enabled |
| --- | --- |
| Eligible local or connected MCP tool | Searchable; schema deferred unless initially selected |
| Built-in not enabled or explicitly opted in | Absent from search results |
| Enabled on-demand MCP server | Server name and description searchable before connection |
| Enabled MCP server whose startup connection failed | Server entry available for an explicit scoped retry |
| MCP server with `enable: false` | Absent; search cannot connect it |
| Tool excluded by a host or server allowlist | Absent; exact-name search cannot bypass the exclusion |

Enabling tool search deliberately extends on-demand MCP behavior: the model may select an enabled server through search without a `$mcp_<name>` reference. With search disabled, the existing reference-based behavior remains unchanged.

### Explicit references

Preserve reference resolution and precedence from the dynamic MCP feature:

- `$tool_name` makes that tool available before the first request, subject to existing rules.
- `$mcp_<name>` connects the server when needed and discloses all its allowed tools before the first request. This remains an explicit request to load the server's tools.
- A reference consumed by a skill is not also treated as a tool or MCP reference.
- Loading a skill does not automatically authorize every tool mentioned in its text. Existing skill and host tool restrictions still apply.

Search adds a way to discover capabilities when the user does not know their names. It does not change the meaning of existing references, quoted text, or steering messages.

## Search interface

Expose one function tool, `tool_search`:

```json
{
  "query": "find an issue in github",
  "limit": 5
}
```

| Argument | Contract |
| --- | --- |
| `query` | Required, nonempty text: an exact tool name or words describing the task |
| `server` | Optional configured MCP server name; restricts search to that server and connects it if needed |
| `limit` | Optional integer, default 5, range 1–10; bounds the combined number of tool and server matches |

A search without `server` examines eligible local tools, allowed tools from already connected servers, and configured server names and descriptions. It must not open any new MCP connection. A match for an unconnected server is a server result, not a claim that a particular tool exists.

A search with `server` resolves that name using existing case-insensitive MCP name rules, connects only that server when necessary, discovers its allowed tools, and searches those tools. It reuses a healthy connection already available to this task. No wildcard server selection or automatic fan-out is supported.

Tool matches are disclosed automatically. Server matches alone are not connected. Return bounded metadata, for example:

```json
{
  "tools": [
    {
      "name": "web_search",
      "description": "Search the web.",
      "source": "builtin",
      "already_loaded": false
    }
  ],
  "servers": [
    {
      "name": "github-work",
      "description": "Search repositories and read issues in the work GitHub account.",
      "connected": false
    }
  ],
  "has_more": false
}
```

The result need not repeat parameter schemas. Complete schemas are supplied through the next request's `Tools` field. `already_loaded` describes disclosure before this search; repeated searches do not duplicate tools or sessions. `has_more` means further matches were omitted by `limit`; the model can refine the query or use an exact name. No pagination is required in the first version.

An MCP tool result also identifies its configured server. A server result tells the model to search again with `server` to inspect its tools. These result objects are application data, not a provider-specific `tool_reference` content type.

### Matching

Use a local, deterministic search over names, descriptions, and MCP server names. Exact tool-name matches rank first, followed by name-prefix matches and then textual matches. Rank ties by canonical name and result kind. Preserve complete names in results; never synthesize a tool name from a server description.

Normalize case and split identifier separators so that `get_issue` can match `get issue`. Match Unicode text without corrupting it. The first version does not promise semantic or cross-language retrieval; model instructions should encourage retries using likely tool names or the language of the descriptions. No embedding service, vector database, or model reranker is required.

Return an empty result when nothing matches. Do not fall back to disclosing every tool. Invalid arguments and unavailable servers produce structured tool errors with a concise reason and whether retrying may help.

## Model interaction

The stable system instruction explains that more tools can be found with `tool_search`, that a server result requires a scoped search, and that newly found tools can be called only on the following step.

Example with an on-demand server:

```text
User: Find the issue about login failures in the work repository.

Step 1: tool_search(query="github repository issue")
Result: server github-work; no connection opened.

Step 2: tool_search(server="github-work", query="get issue")
Result: mcp_github-work__get_issue; server connected.
Next request: includes the get_issue schema.

Step 3: mcp_github-work__get_issue(...)
Result: handled by the existing MCP adapter and execution policy.
```

Do not include the deferred catalog in system tool summaries, prompt examples, or unknown-tool errors. Prompt rules for specific tools, including planning and shell tools, must either refer to initially disclosed tools or instruct the model to search before calling them. Do not claim that a deferred tool is already callable.

Keep the system prompt stable after preparation. Add discovered definitions to `Request.Tools`; do not rebuild the full system prompt to append tool summaries after every search. This reduces redundant text but does not guarantee provider prompt-cache hits when the tool list changes.

## Engine and runtime requirements

### Task state and execution

Keep the eligible catalog separate from the disclosed set. Reuse the existing `tools.Tool` implementations and MCP adapters; do not introduce a second generic tool executor.

Build each model request from the disclosed set rather than a tool list frozen at run initialization. Dispatch must check the same set that was visible for that request. A model that guesses a deferred name receives an error directing it to `tool_search`; it cannot invoke the tool early.

Apply disclosure changes between model steps, after the current batch of tool calls finishes. If a response contains both a search and a call to a previously deferred tool, the latter is rejected for that step. Parallel searches merge successful additions without duplicate registrations, data races, or repeated connections to the same server. Keep ordering deterministic.

Disclosed tools remain available for the rest of the run. The first version does not evict tools. Existing context accounting and compaction must include the current tool schemas. Reject an addition that cannot fit within the request budget even after permitted compaction; report the failure and keep the previous disclosed set. Never truncate a parameter schema to make it fit.

Search-result descriptions may be shortened to bound output, but tool names must remain complete. Validate schemas before publishing them. A failed disclosure must not be reported as a successfully loaded tool.

### MCP ownership and errors

Reuse startup-owned sessions without closing them when a task ends. Connections opened by a scoped search belong to that task and follow the existing task connection timeout and cleanup rules, including cancellation and approval pauses.

A failed scoped search returns a tool error and leaves existing tools usable. It must not publish a partial set of tools from a failed connection or registration. Do not automatically retry a failed connection on every unrelated global search. An explicit scoped search may retry it.

Keep `$mcp_<name>` preparation failures unchanged: an explicit reference that cannot load its enabled server still fails preparation. This differs from a search error, which occurs inside an already running task and allows the model to choose another approach.

Never mutate the shared runtime registry or persist a search choice into configuration. Two concurrent tasks may disclose different tools from the same server.

### Approvals, compaction, and resume

Disclosure state is structured run state, not something reconstructed from model prose. Context compaction must retain the disclosed names even if earlier search messages are removed.

Persist the disclosed tool names and the server identities needed to restore them in approval resume state. Do not persist live sessions, credentials, or copied transport configuration there. Resume reconnects task-owned servers and revalidates current permissions before restoring definitions and executing an approved call. Do not rerun ranked searches to recover the set.

Bind the pending action to its tool source and schema identity as well as the existing approval identity and arguments. If the server configuration, tool source, or schema relevant to that action changed, stop resume with a clear error; do not apply an old approval to a different action. Older pending records without disclosure state keep their existing resume behavior.

An MCP session may hold server-side state that does not survive reconnecting. Preserve the existing dynamic MCP limitation and report missing state rather than claiming that restoring a schema restores a session.

### Entry points and providers

Integrate through shared task preparation and the engine. Cover CLI, Console, Console-managed channels, standalone channels, cron, TODO, heartbeat, and handoffs where those entry points already prepare tools. Decision-only and lightweight precheck calls do not gain tool search.

Subtasks keep their current capability restrictions, including `DisableRuntimeTools`. A child receives only a catalog permitted by its own task preparation; search cannot recover tools excluded by its parent or host. Loaded schemas are not automatically inherited as additional authority.

Embedding callers can opt into search over their supplied registry without configuring MCP. Existing callers retain their current behavior by default. The catalog must support custom tools without depending on the built-in tool factory.

Use the same disclosure rules for native function calling and the existing tool-emulation path. Provider changes or retries must preserve the current disclosed set. A provider that cannot support the existing tool loop should report that limitation, not silently send the entire deferred catalog as a fallback.

## Policy and observability

Search is not authorization. Host allowlists, MCP `allowed_tools`, credentials, sandbox rules, guard checks, and action approvals still govern execution. Tool descriptions and schemas are untrusted metadata and cannot instruct the runtime to expand those permissions.

Log search duration, match counts, newly disclosed names, connection outcomes, and the disclosed tool count and serialized schema bytes per model request. Respect existing log settings and redaction. Queries, schemas, server credentials, and full descriptions should not be added to ordinary info logs.

Request dumps should make it possible to confirm that deferred schemas were absent and show when definitions first appeared. Compare request size and task completion against search-disabled runs; smaller requests alone are not sufficient if the model cannot find the required tool.

## Acceptance criteria

| Case | Expected result |
| --- | --- |
| Feature disabled | Existing schemas, references, connection timing, and execution behavior remain unchanged |
| Large eligible catalog | First request contains only `tool_search`, eligible `always_loaded` entries, and explicit opt-ins; no hidden catalog in the prompt |
| Search returns three new tools | Exactly those three schemas appear on the next request; their full schemas are not duplicated in the result text |
| Repeated or exact-name search | Stable ranking, no duplicate definitions, and exact eligible names remain reachable |
| No match or invalid query | Bounded empty result or argument error; no bulk disclosure |
| Global search matches an on-demand server | Returns server metadata without connecting it |
| Scoped MCP search | Connects only the named enabled server, applies its allowlist, and discloses only matching tools |
| Disabled or excluded capability | Absent from results; exact names and guessed calls cannot enable it |
| Explicit references | Existing precedence remains; referenced tools and allowed tools of referenced servers are initially disclosed |
| Search and newly found tool in one response | New tool call rejected until the next step |
| Parallel searches and concurrent tasks | Deterministic additions, one connection per server per task, no shared disclosure state |
| Timeout, cancellation, invalid schema, or registration collision | Clear error, no invalid tool publication, task-owned resources released |
| Context pressure and compaction | Current schemas counted; disclosed state survives compaction; no invalid schema truncation |
| Approval pause and resume | Disclosed tools restored under current policy; changed pending action identity prevents execution |
| Provider retry, emulation, and fallback | Same disclosed set; no accidental exposure of all schemas |
| Runtime coverage | Shared behavior across supported entry points; subtask and precheck restrictions preserved |

Use fake model clients, local fake tools, and stub MCP transports for regression tests. Tests must not depend on credentials, external servers, or database connections. Include a fixed large catalog benchmark that records initial and subsequent schema bytes, search latency, and model-step count. Include representative task traces showing both successful discovery and recovery from a failed search.

## Implementation sequence

For each phase, add its regression tests and run them before changing production logic.

1. **Local catalog and search:** configuration, eligibility filtering, deterministic matching, custom registry support, and search result limits.
2. **Engine disclosure:** initial selection, prompt changes, per-step schemas, dispatch checks, parallel-call handling, context accounting, approval state, and resume.
3. **MCP discovery:** configured descriptions, global server results, scoped connections, allowlist filtering, task ownership, and timeout cleanup.
4. **Integration:** Console settings, all shared runtime paths, provider and emulation checks, request diagnostics, benchmarks, and configuration documentation.

Keep the feature off by default throughout implementation. Do not describe it as complete until search, execution, and approval resume work together.

## Outside the first version

- Installing MCP servers or changing saved configuration from search.
- Searching a remote marketplace or an unconfigured server.
- Loading MCP resources, prompts, or skill bodies through `tool_search`.
- Cross-task session pooling or a persistent search index.
- Semantic retrieval, embeddings, learned ranking, or automatic server fan-out.
- Automatic schema eviction or a separate schema-fetch tool.
- Provider-native `tool_search` or `tool_reference` transport support. These can be adapters later if they preserve the same eligibility and disclosure behavior.
