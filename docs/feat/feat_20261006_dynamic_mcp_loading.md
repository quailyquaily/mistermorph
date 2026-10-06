---
date: 2026-10-06
title: "Load configured MCP servers through explicit task references"
status: implemented-v1
---

# Load configured MCP servers through explicit task references

## Goal

Let a task write `$mcp_<name>` to load a configured MCP server that is not connected by default. Load its tools before the first main-model request, for that task only, without changing the saved configuration.

This extends [explicit skill and tool opt-in](feat_20260525_explicit_capability_opt_in.md). The first version supports server-level references only.

## Current behavior

- `internal/mcphost/config.go` defines each server's local `name`, transport, credentials, and `allowed_tools`. `ValidateName` already enforces the name pattern below.
- `internal/mcphost/host.go` connects every server with `enable: true` when a runtime starts and skips the others. It discovers tools and registers them in the runtime's base registry, so every task sees them.
- Tool names are `mcp_<server_name>__<tool_name>`, for example `mcp_github-work__get_issue`.
- `$name` resolves skills first, then known built-in tools (`skillsutil.ResolveTaskSkillRefs`, `toolsutil.BuiltinToolTriggers`). It cannot load an MCP server.
- `mcphost.Connect` only logs a server that fails to connect. It keeps no per-server status.

## Configuration

`enable: false` keeps its meaning: the server is off. It is never connected, and `$mcp_<name>` does not reach it.

A new optional field, `on_demand`, marks an enabled server that is not connected at startup:

```yaml
mcp:
  servers:
    - name: github-work
      enable: true
      on_demand: true
      type: http
      url: "https://mcp.example.com/mcp"
      headers:
        Authorization: "Bearer ${MCP_REMOTE_TOKEN}"
      allowed_tools: ["search_repositories", "get_issue"]
```

| `enable` | `on_demand` | Behavior |
| --- | --- | --- |
| `true` | `false` (default) | Connected at startup; its tools are in every task (today's behavior) |
| `true` | `true` | Not connected at startup; connected for a task that references it |
| `false` | any | Off; never connected, and a reference to it is ordinary text |

Add `on_demand` to `assets/config/config.example.yaml`, the Console MCP settings panel (a "Load on demand" switch shown while the server is enabled), and the settings validation.

### Server names

The pattern is unchanged: `[A-Za-z][A-Za-z0-9_-]*`, no spaces.

| Name | Valid | Why |
| --- | --- | --- |
| `github-work` | yes | |
| `github_work` | yes | |
| `gh2` | yes | |
| `github-` | yes | A trailing hyphen is allowed |
| `github work` | no | Contains a space |
| ` github` | no | Leading space |
| `2fa` | no | Starts with a digit |
| `github.work` | no | Dots are not allowed |
| `工作` | no | Non-ASCII |

New: names must be unique ignoring case. `GitHub` and `github` conflict.

- Console settings refuse to save a server list with conflicting names.
- At startup, conflicting entries are all skipped with a warning naming them, rather than guessing which one was meant. The rest of the list loads as usual.

References match names ignoring case, and tool names keep the configured spelling: `$mcp_GITHUB-WORK` loads `github-work`, whose tools are `mcp_github-work__search_repositories` and `mcp_github-work__get_issue`.

Invalid names are not normalized into valid ones; they need an explicit configuration edit.

## Reference resolution

```text
$mcp_github-work Find the issue that describes this bug.
```

Resolve each reference in this order:

1. A matching skill, following the existing skill precedence rule.
2. A known built-in tool.
3. `mcp_` followed by the complete name of a configured, enabled server.
4. Otherwise, leave it as ordinary task text.

A skill named `mcp_github-work` therefore takes precedence over the MCP reference. Repeated references to the same server load it once per task. Several servers may be referenced in one task.

Reuse `caprefs.Names`, but an exact server-name match comes before its trailing-punctuation trimming:

| Text | Configured server | Loads |
| --- | --- | --- |
| `$mcp_github-work, please` | `github-work` | `github-work` |
| `see $mcp_github-work.` | `github-work` | `github-work` (trailing dot trimmed) |
| `$mcp_github- what's new` | `github-` | `github-` (exact match kept) |
| `$mcp_github- what's new` | `github` only | `github` (trailing hyphen trimmed) |

The reference loads capabilities; it does not invoke a tool. The model still chooses tool calls and arguments through the normal tool loop. Individual MCP tool references are outside this version's scope.

### Which text is read

References are read from the task text of every run that prepares a task: chat messages in channels and the Console, CLI tasks, cron and TODO runs, heartbeat runs, and handoffs from other Agents. Cron, TODO and heartbeat may load servers by design, including from a TODO the model wrote with `todo_update`.

Not read:

- Subtasks. They run with `DisableRuntimeTools` and load no opt-in tools today.
- Messages steered into a running task. They never reach task preparation, so a reference in them is ignored.
- Quoted messages. Telegram is the only channel that puts the quoted message into the task text (`Quoted message: … User request: …`). It passes the user's own text with the message as `RunRequest.ReferenceText`, and task preparation reads references from `ReferenceText` when set, otherwise from `Task`. This applies to all `$` references, since skills and tools use the same parser, so a quoted `$skill` no longer opts in either.

## Loading behavior

| Server and task | Behavior |
| --- | --- |
| Loaded at startup, no reference | Unchanged |
| Loaded at startup, referenced | Nothing more to do; its tools are already in the task |
| Startup connection failed, referenced | Connect it for this task, as for an on-demand server |
| On demand, no reference | Not connected; no tools |
| On demand, referenced | Connect and register its allowed tools for this task |
| Off, or no such server | The reference is ordinary text |

For each server a task loads:

1. Resolve the reference against the runtime's configuration snapshot.
2. Validate the server configuration.
3. Connect with its configured stdio or HTTP transport.
4. Discover tools and apply `allowed_tools`.
5. Register the tools in the task's registry before the prompt is rendered and tool schemas are sent to the model.
6. Close the connection when the run ends (see "Connection lifetime").

Connect and discovery share a 30-second timeout per server, under the task's context, so cancellation also stops them. A stalled server fails the task instead of leaving preparation waiting.

Use the existing MCP adapters and `RegisterHostTools` rollback. Never add task-loaded tools to the base registry; concurrent tasks must not gain tools from each other's references. Servers connected at startup stay owned by the runtime, and task cleanup never closes them.

### Per-server status (phase 2)

`mcphost.Host` records each configured server's startup outcome: `connected`, `failed` (with the error), `on_demand`, `disabled`, or `invalid`. Task preparation reads it to decide whether a referenced server is already loaded, must be connected for the task (`on_demand` or `failed`), or is off (`disabled`, `invalid`, or unknown). A connected server's status also gives the tool names it registered, so a reference to it is checked, not assumed.

### Connection lifetime

Task-loaded connections belong to one prepared run, the same way `taskruntime` already owns a per-run image client:

- `prepareRun` connects the referenced servers and adds their sessions to the run's cleanup.
- `Run` and `Resume` close the prepared run when they return, and so close those sessions, whether the run finished, failed, was canceled, or paused for approval.
- `Resume` already prepares the run again from the job's task text. It resolves the same references and reconnects the same servers before the approved tool call continues. Resuming after a restart takes the same path; no MCP state is persisted.

Server-side MCP session state is not kept across an approval pause; the resumed run starts a new session. Tools that rely on session state from earlier calls in the same run may need to repeat that setup.

## Runtime integration

The loading happens in `taskruntime.prepareRun`, which CLI tasks, Console chat, channel runtimes (including Console-managed ones), cron, heartbeat and agent handoffs already share. `CommonDependencies` gains the MCP server configs and the host's per-server status for the current generation.

Capability references must not be answered with an emoji:

- The lightweight pre-check skips any message containing a `$name` reference (`caprefs.Names` finds one). This covers skills, tools and MCP servers, and an unrecognized `$name` only means the main loop runs as it would without the pre-check.
- When the group check accepts a message with a `$name` reference, its emoji choice is ignored and the message goes to the main loop.

Neither changes channel authorization or group admission.

The loaded tools stay available for every step of the run.

## Failure handling and boundaries

A reference to a configured, enabled server is a request to use it. If the configuration is invalid, connecting or discovery fails or times out, or registration fails, fail task preparation with an error naming the server and the failed step, for example `mcp server "github-work": connect: context deadline exceeded`. Do not continue as if the capability were available.

If discovery and `allowed_tools` leave no tools, fail the same way (`mcp server "github-work": no allowed tools`). If preparation fails after other task-owned connections opened, close all of them.

Failures of startup servers that the task did not reference keep today's behavior: logged, and the runtime continues without them.

Loading respects `allowed_tools`, guard checks, credentials, transport requirements and tool argument validation. Only commands, URLs and credentials from the selected configuration are used: a reference cannot supply a new command or endpoint, install a server, or change its permissions. Log the server name and loading outcome, never credentials or headers.

## Implementation phases

Write and run failing tests before each phase's implementation. Run the relevant regression tests after each phase.

### Phase 1: Configuration and references

- Add `on_demand` to `ServerConfig`, the config template, the Console MCP panel and settings validation.
- Reject case-insensitive duplicate names on save; skip conflicting entries at startup with a warning.
- Resolve `$mcp_<name>` against enabled servers: skill precedence, case-insensitive matching, deduplication, exact match before trailing-punctuation trimming, off and unknown servers as ordinary text.
- Add `RunRequest.ReferenceText`; Telegram passes the user's own text, and references are read from it when set.

### Phase 2: Host status and per-task loading

- Record per-server startup status in `mcphost.Host`.
- Connect referenced on-demand servers, and referenced startup servers that failed, for one task, with the 30-second timeout; filter tools and register them only in the task registry.
- Cover invalid configuration, connection, discovery, timeout, empty-tool-set and registration failures, partial-failure cleanup, cancellation, and isolation between concurrent tasks.

### Phase 3: Task lifecycle and entry points

- Own task-loaded sessions in the prepared run's cleanup; reconnect on `Resume`.
- Pass the configs and host status through `CommonDependencies` for all entry points.
- Skip the lightweight pre-check, and ignore the group check's emoji choice, for messages with a `$name` reference.
- Cover completion, cancellation, failure, approval pause and resume, and tasks without references.

Use local test MCP servers and fake transports. Tests must not require external services or download executable server packages.

## Implementation notes (v1)

- `mcphost.Connect` records each server's `ServerStatus` and returns a host whenever servers are configured, even if none connected, so task preparation can read the status. Duplicate names are skipped there.
- `mcphost.ReferencedServers` resolves references using `caprefs.Refs`, which returns each reference as written and trimmed. `mcphost.LoadReferenced` decides what to connect, and `mcphost.ConnectServers` connects strictly, with the timeout.
- The timeout needs more than a context: when `initialize` times out, the MCP SDK sends `notifications/cancelled` on a context detached from the caller's, so a stalled HTTP server would still hold the connect. Each task connection therefore gets an abort that fires at the deadline: it cancels every in-flight HTTP request to that server, and kills a stdio server's process. Once connected, the abort is disarmed and only runs on `Close`.
- `CommonDependencies.LoadReferencedMCP` is built with `depsutil.MCPLoader` (or `MCPLoaderFromServers` in `integration`) wherever dependencies are assembled: channel generations, the Console runtime and its managed runtimes, `run`, `chat`, and the embedding API. `taskruntime.prepareRun` and the awareness runner (heartbeat and cron) call it.
- `RunRequest.ReferenceText` also drives `$skill` and `$tool` references. Telegram carries it on the bus in `MessageExtensions.ReferenceText`.
- `core.HasCapabilityReference` is the shared test for "has a `$name` reference": `LightweightPrecheckApplies` uses it, and each channel's group check stops offering emojis for such messages.
- Console: a "Load on demand" switch in the server dialog, and a hint in the server list.

## Acceptance criteria

- An on-demand server is not contacted until a task references it.
- A server with `enable: false` is never contacted, referenced or not.
- A referenced server's allowed tools appear in the first main-model request.
- Tool calls use the existing MCP adapter, guard and execution path.
- The saved configuration is unchanged by loading.
- A later task without the reference does not get the loaded tools.
- Repeated references do not create duplicate connections or tools within a task.
- A message with a `$name` reference is never answered with only an emoji.
- A `$mcp_<name>` inside a quoted Telegram message loads nothing.
- Loading failures are visible and name the server; every task-owned connection is closed when its run returns.
- An approval resume reconnects the referenced servers before the approved call continues.

## Out of scope

- Connection pooling or reuse across unrelated tasks.
- Automatic server discovery or installation.
- Changing a running task's tool set: the model cannot load a server mid-run, and references in steered messages are ignored. (A TODO the model writes is a new task, and may load servers when it runs.)
- New aliases, display-name fields, or quoted reference syntax.
- MCP resources and prompts; this change loads MCP tools only.
