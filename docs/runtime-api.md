# Runtime API

External processes can control a running MisterMorph through HTTP and JSON.
Two standalone OpenAPI 3.0.3 documents are available:

| Document | Scope |
| --- | --- |
| [Control](runtime-api.control.openapi.yaml) | 12 paths, 14 operations: health, task submission, status and final results, topic history, cancellation, approval queries and decisions, and the Console task WebSocket. Start here for an external process client. |
| [Full](runtime-api.full.openapi.yaml) | All Control operations plus workspace, files, contacts, schedules, observability, settings, provider login and setup routes mounted under the runtime base URL. |

Both files can be imported independently into an OpenAPI viewer or client
generator. Control is an exact subset of Full, including its request and
response schemas. They use the same server and Bearer token; this split does
not create a separate listener or restrict token permissions. Browser-only
`/api` routes are outside both documents.

Control explicitly includes `GET /tasks/{task_id}` for authoritative status and
final results, and `GET /approvals`, `GET /approvals/{approval_id}`,
`POST /approvals/{approval_id}/approve` and `/deny` for approval handling.
WebSocket progress is optional and does not replace result retrieval.

This is a reference for the current implementation, dated 2026-10-02. The date
is a document revision, not a negotiated protocol version. There is no `/v1`
prefix or API version negotiation. Objects may gain fields; clients should
ignore fields they do not recognize.

## Address and authentication

For Console, set `server.auth_token`, preferably through
`MISTER_MORPH_SERVER_AUTH_TOKEN`, before starting `morph console`. The API is
then available at `<console.base_path>/runtime` on the Console listener. With
the default configuration, its base URL is `http://127.0.0.1:9080/runtime`.
Without an explicit token, Console does not expose this public runtime route.

Send `Authorization: Bearer <server.auth_token>` on protected requests.
This token differs from the browser session token used by `/api`. External
clients can call `/runtime` directly; they do not need `/api/proxy`, a Console
login, or a browser stream ticket. Use HTTPS for remote connections.

Channel runtimes expose the shared handler when their API listener is enabled.
Use their full base URL, normally ending in `/runtime`. Standalone channel
servers also retain unprefixed routes for compatibility; new clients should use
`/runtime`. The Console Web listener does not expose those unprefixed aliases.
`morph run` is a one-shot CLI and does not start this HTTP API.

`GET /health` and `HEAD /health` are public when registered. Check `mode` and
`submit_enabled`, but do not treat health as a complete capability catalog.
Topic, approval, workspace, stop, poke and schedule-run handlers depend on the
runtime. An absent handler usually returns `503`; disabled task submission
returns `405`. Routes that are not registered return `404`. The task WebSocket
is a Console extension.

All paths below are relative to the runtime base URL.

## Submit, inspect and continue a task

These examples assume the server is running and the calling process already
has `MISTER_MORPH_SERVER_AUTH_TOKEN`. The shell examples use `curl` and `jq`.

```bash
MORPH_RUNTIME_URL='http://127.0.0.1:9080/runtime'

curl --fail-with-body -sS "$MORPH_RUNTIME_URL/health"

MORPH_SUBMISSION=$(curl --fail-with-body -sS "$MORPH_RUNTIME_URL/tasks" \
  -H "Authorization: Bearer $MISTER_MORPH_SERVER_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"task":"Summarize the project structure.","timeout":"2m"}')

MORPH_TASK_ID=$(printf '%s' "$MORPH_SUBMISSION" | jq -er '.id')
MORPH_TOPIC_ID=$(printf '%s' "$MORPH_SUBMISSION" | jq -er '.topic_id')

curl --fail-with-body -sS "$MORPH_RUNTIME_URL/tasks/$MORPH_TASK_ID" \
  -H "Authorization: Bearer $MISTER_MORPH_SERVER_AUTH_TOKEN"
```

Submission returns **200**, with an object such as:

```json
{"id":"task-example","status":"queued","topic_id":"topic-example"}
```

Poll `GET /tasks/{task_id}` for the result. A task error is represented by the
task's `status` and `error`, even when the GET request itself succeeds with 200.

| Task status | Client behavior |
| --- | --- |
| `queued` | Wait for execution. |
| `running` | Continue polling; optionally display stream previews. |
| `pending` | Inspect `approval_request_id`; execution is waiting for approval. |
| `done` | Read `result`. |
| `failed` | Read `error` and any partial `result`. |
| `canceled` | Execution ended by cancellation; partial results may remain. |

`TaskInfo.result` is a runtime-dependent JSON value. Console commonly returns
the answer at `result.final.output`, with optional execution details such as
`trace`, `plan` and `activity`. `output` itself can be structured JSON. Do not
assume every runtime returns a string or an identical result envelope.

For an ordinary Console submission, omitting `topic_id` creates a topic.
Supplying it continues an existing topic; an unknown explicit ID is rejected.
There is no empty-topic creation endpoint. Save the returned ID before sending
another message:

```bash
jq -n --arg topic "$MORPH_TOPIC_ID" \
  '{topic_id:$topic,task:"Explain the main execution path."}' |
  curl --fail-with-body -sS "$MORPH_RUNTIME_URL/tasks" \
    -H "Authorization: Bearer $MISTER_MORPH_SERVER_AUTH_TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-
```

In Console, text submitted while that topic has an active run may become
steering input for that run. The response records a separate completed task
for the acknowledgement. When `steer_target_task_id` is present, follow that
target for the main result. This path applies to plain text without file
references after runtime command handling; commands and file-bearing messages
can follow different execution paths. There is no separate HTTP steer route.

Send supported slash commands through the same `task` field. `GET /commands`
lists shared suggestions; runtime support can differ. For example, Console
accepts `/models set <profile>` to change the topic's model profile and `/reset`
to clear model context while retaining chat history.

The API does not implement submission idempotency keys. If a connection fails
after sending a POST, the task may already exist. Inspect topics and task
history before retrying, especially when creating a new topic. Disconnecting
an HTTP client or WebSocket does not cancel accepted work.

## Pagination, cancellation and approval

`GET /tasks` returns newest tasks first. `GET /topics` orders topics by their
latest update. Both return `items`, `limit`, `has_next` and an optional
`next_cursor`. Pass that cursor unchanged to fetch the next page, retaining
the same filters. Cursors are opaque and endpoint-specific; pagination is not
a frozen snapshot of a changing runtime.

Task pages default to 20 items and topic pages to 100; both allow 1–200.
Use `topic_id` and `status` to filter task pages. `GET /approvals` defaults to
20 items, allows 1–200, and accepts only the `pending` status. It is a bounded
list without cursors.

```bash
curl --fail-with-body -sS -X POST \
  "$MORPH_RUNTIME_URL/tasks/$MORPH_TASK_ID/stop" \
  -H "Authorization: Bearer $MISTER_MORPH_SERVER_AUTH_TOKEN"
```

Stopping is asynchronous. Console returns `status: stopping` and `found: true`
when the controller finds work; poll for the task's final state. If no active
work matches, it returns 200 with `status: not_found` and `found: false`.
`POST /topics/{topic_id}/stop` requests cancellation for the topic.

For pending approval, read `GET /approvals/{approval_id}` and send
`POST /approvals/{approval_id}/approve` or `/deny`. The decision body is
optional; it can contain `actor` and `note`. The ID in the URL overrides any
ID in the body. Inspect `status`, `resumed` and `error` in the response, then
continue querying the associated task. HTTP 200 alone does not establish that
execution resumed. These endpoints require the runtime token.

In Console, `PUT /topics/{topic_id}/tags` with `{"tags": [...]}` replaces a topic's
tags; topics carry them in `tags`. The reserved tag `pinned` pins the topic to the
top of the Console topic list.
`GET /topics/layout` and `PUT /topics/layout` read and replace how the topic
list's tag view is arranged: `tag_order` lists the tag groups in order, and
`topic_order` lists the topic IDs of a tag group or the pinned group in order.
Groups are named `tag:<tag>` (lower case) and `pinned`.

Deleting a topic uses `DELETE /topics/{topic_id}` and returns 204 with no body.
Console also stops topic work and removes its context. This is distinct from
stopping an execution or resetting its model context.

## Workspaces and files

All filesystem paths refer to the **server**. `PUT /workspace` attaches an
existing directory to a topic. `DELETE /workspace?topic_id=...` removes the
attachment and resolves the server default; it does not disable workspace
access. `GET /topic/{topic_id}/metadata` reports workspace resolution and
model context usage. Notice the singular `topic` in this metadata path.
In Console, `GET /topic/{topic_id}/context` returns the topic's last main request split into
parts (system prompt sections, skills, tool definitions, history, the current message and this
run's steps) with token counts that add up to the reported total. When the provider can
count tokens, the first look counts the parts with it; otherwise they are estimated locally.

Upload with `POST /files/upload`, using multipart field `files` once per file.
The entire request is limited to 64 MiB. Destination precedence is explicit
`workspace_dir`, resolved topic workspace, runtime default workspace, then the
Console subdirectory of the file cache. Repeated filenames are renamed rather
than overwritten. Use the returned `dir_name` and `path` as `file_references`
in the next task submission. The upload itself does not submit a task.

Downloads and previews require `dir_name` and `path`; `workspace_dir` also
requires `topic_id`. Paths cannot escape the selected root. Download returns
file bytes as an attachment. Preview permits the HTML/CSS/JavaScript, JSON,
image and font extensions listed in the OpenAPI description and applies a
sandbox Content Security Policy. PDF is not currently a preview type.

`/workspace/open` opens a path on the server desktop when that capability is
available. It does not open a file on the API caller's computer.

## WebSocket snapshots

Console exposes:

```text
ws://127.0.0.1:9080/runtime/stream/ws?task_id=task-example
Authorization: Bearer <server.auth_token>
```

Use `wss` when the HTTP base URL uses HTTPS. The server accepts an absent
`Origin`; when provided, its host must match the request host. A process client
must support an Authorization header during the upgrade. The browser WebSocket
API cannot set this header; the Console browser UI has separate ticket-based
routes under `/api` that are outside this API.

Each connection subscribes to one task through the URL. No JSON subscription
message is required, and client application messages are not commands. The
server sends JSON text frames described by `StreamFrame` in both OpenAPI files:

```json
{
  "task_id": "task-example",
  "seq": 12,
  "status": "running",
  "text": "I have inspected the entry points.",
  "preview": true
}
```

| Field | Meaning |
| --- | --- |
| `task_id`, `seq` | Task identity and stream-hub sequence number. |
| `status` | Current stream status hint. |
| `text`, `reasoning` | Accumulated snapshots; replace displayed text rather than append deltas. |
| `plan` | Current plan steps, statuses and notes. |
| `activity` | Current activity and bounded recent activity history. |
| `trace` | Bounded execution records with their own entry sequence numbers and omitted count. |
| `preview` | Text is an intermediate preview. |
| `done`, `error` | Stream completion or failure hints; verify through HTTP. |

`seq` is global to the in-memory hub, so gaps between a task's frames are normal.
It is not a durable replay cursor. A slow consumer can miss intermediate
snapshots. On connection, the hub sends its latest snapshot if one is retained;
it does not replay every prior frame. A finished task's snapshot may already be
gone, and an unknown task ID can still complete a WebSocket handshake.

Poll `GET /tasks/{task_id}` alongside streaming and use HTTP state and result as
authoritative. Stream failures, previews and cancellation do not necessarily
have exactly the same status or timing as stored task state. The server does
not automatically close the socket after a `done` frame. Clients can close it
after confirming the terminal task state. Reconnect with backoff when needed;
there is no resume-token parameter.

The server sends a WebSocket ping every 25 seconds. Its read deadline is 90
seconds, renewed by pong frames. Use a client that processes control frames and
responds with pong even when no application data is being sent.

## Errors and limits

Shared HTTP routes generally return successful JSON and plain-text errors
(`text/plain; charset=utf-8`). File endpoints return bytes. Console-owned
extensions and pre-upgrade stream errors can instead return JSON with `error`
and sometimes `ok: false`; upgrade failures can still be plain text. Check the
HTTP status and Content-Type before decoding a body.

The OpenAPI documents describe each operation's errors. In particular, `503` can
mean an optional capability is missing, not merely a temporary outage. A 200
task query with `status: failed` is an execution failure, not an HTTP failure.

Task submission, workspace mutations and approval JSON decoding read up to
1 MiB; text-file and schedule replacement read up to 4 MiB. These decoder
limits are not a promise of a 413 response: invalid or truncated JSON usually
returns 400. Upload enforces 64 MiB, persona avatar writes enforce 2 MiB, and
`/poke` enforces 10 KiB. `/poke` accepts nonblank textual content rather than
a task envelope, returns 202, and does not return a task ID.

## Scope and management extensions

Full covers the shared runtime routes, the Console task WebSocket and the
management extensions below. Control contains only the execution and approval
subset described above. Aggregate statistics and agent event payloads contain
extensible objects rather than a frozen schema for every internal counter or
event. Full also documents the handler's public root liveness response;
Control uses `/health` instead.

Configuration, authentication and setup extensions are defined in Full and
excluded from Control. All paths in this table use the runtime base URL and
runtime token when exposed there. Their availability is marked per operation.

| Methods and paths | Availability / implementation |
| --- | --- |
| `GET, PUT /settings/agent` | Shared handler when agent settings are enabled; Console supplies its own owner. See [agent settings](../internal/agentsettings/handler.go). |
| `POST /settings/agent/models`, `POST /settings/agent/test` | Model lookup and connection tests through the same settings handler. |
| `GET /settings/agent/skills`, `/settings/agent/skills/detail`, `/settings/agent/skills/store`; `POST /settings/agent/skills/remove` | [Skill management](../internal/agentsettings/skills_catalog.go), when settings are enabled. |
| `GET /auth/codex/status`; `POST /auth/codex/refresh`, `/auth/codex/login/start`, `/auth/codex/login/poll`, `/auth/codex/logout` | Settings-enabled runtimes and Console; [auth handler](../internal/codexauth/http_handler.go). |
| `GET /auth/xai/status`; `POST /auth/xai/login/start`, `/auth/xai/login/poll`, `/auth/xai/logout` | Console; [xAI login](../cmd/mistermorph/consolecmd/xai_auth.go). |
| `GET /auth/pro/status`; `POST /auth/pro/login/start`, `/auth/pro/login/poll`, `/auth/pro/logout` | Console; [Pro login](../cmd/mistermorph/consolecmd/pro_auth.go). |
| `GET, PUT /settings/console` | Console; [channel and Console settings](../cmd/mistermorph/consolecmd/console_settings.go). |
| `GET, PUT /settings/system` | Console; [system settings](../cmd/mistermorph/consolecmd/system_settings.go). |
| `GET, PUT /settings/auto-update`; `POST /settings/auto-update/check` | Console; [update settings](../cmd/mistermorph/consolecmd/auto_update_settings.go). |
| `POST /settings/wechat/login/start`, `/settings/wechat/login/poll`, `/settings/wechat/logout` | Console; [WeChat login](../cmd/mistermorph/consolecmd/wechat_login.go). |
| `GET /setup/integrity`; `GET, PUT /setup/file`; `PUT, DELETE /setup/secret` | Console; [setup repair](../cmd/mistermorph/consolecmd/setup_repair.go). |

Console browser sessions, endpoint selection, proxying, notifications and
artifact tickets belong to `/api` and are described in [Console](console.md).
They are not runtime control endpoints. ACP is also separate: MisterMorph is
currently an [ACP client](acp.md), not an ACP server.

## Maintaining this reference

Update Full and this guide when changing route behavior. If the operation is
also in Control, keep its definition and all referenced schemas identical in
both files. Keep each document self-contained and omit unused components from
Control. The main sources
are [route registration](../internal/daemonruntime/server_routes.go), the
`server_routes_*.go` handlers beside it,
[request/response types](../internal/daemonruntime/types.go),
[task and topic types](../internal/taskdomain/domain.go),
[Console submission](../cmd/mistermorph/consolecmd/local_runtime.go), and
[Console streaming](../cmd/mistermorph/consolecmd/streaming.go). The YAML's
`x-source` entries identify the corresponding Go structures where applicable.

Validate both documents against the official OpenAPI 3.0 schema, resolve local
`$ref` values, and check operation IDs and path parameters after edits. Check
that Control remains an exact subset of Full, including approval and final
result retrieval. Schema
validation checks the document structure; handler review is still needed to
verify behavior, status codes and runtime-specific capabilities.
