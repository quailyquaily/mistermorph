# Mistermorph Console SPA

This document describes the Console under `web/console-nsh`, used by:

```bash
morph console
```

`morph console serve` remains supported with the same flags and behavior.

Stack:
- A TSX app on [nsh](https://nsh.dev) 0.4.0, one source for the web Console, the desktop app
  (`desktop/nsh`, GPUI) and the Android app.
- The web build is a static site (`web/console-nsh/scripts/build-web.sh`); it needs nsh and Node.
- `web/console-nsh/PORTING.md` lists the nsh traps already found.

## Runtime Notes

For external process integration, see the [Runtime API guide](runtime-api.md)
and [Control OpenAPI specification](runtime-api.control.openapi.yaml).
The [Full specification](runtime-api.full.openapi.yaml) also covers runtime
data and management operations.

- Console APIs are served under `<console.base_path>/api` (default: `/api`).
- Runtime views (`Chat`, `Runtime`, `Tasks`, `Stats`, `Audit`, `Files`, `Contacts`) read from the endpoint selected in the top bar.
- `console` always exposes one built-in local runtime endpoint (`Console Local`).
  - It runs tasks in its own runtime loop via shared runtime core.
  - Tasks in one topic run one at a time, in order. Independent topics run at the same time, up to `console.max_concurrency` (default 8, the shared channel default); further topics wait in order for a free slot. A task keeps its slot while it waits on a slow tool, a coding agent or a question to the user, and gives it back when it finishes, fails or is stopped; a task paused for a tool approval gives it back and queues again once approved. Set `1` to run one topic at a time; values below 1 fall back to the default.
  - The limit is local to the Console's own runtime. Managed channel runtimes (`<channel>.max_concurrency`) and TODO runs (`cron.max_concurrency`) have their own limits, and there is no process-wide total. A changed value applies when the Console reloads its config or restarts, without dropping queued or running tasks; after lowering it, running tasks finish and no new topic starts until fewer than the new limit are running.
  - Its runtime API uses the shared `daemonruntime` handler. With an explicit `server.auth_token`, the same handler is available at `<console.base_path>/runtime` on the Web listener.
  - If `server.auth_token` is unset, the local runtime generates an internal in-process token and does not expose `<console.base_path>/runtime`.
  - An explicitly started Console publishes a private loopback control endpoint with generated credentials for local service control. Ordinary terminal chat executes in its own process.
  - Task/topic changes are written to stable segments under `<file_state_dir>/journal/`. When `tasks.persistence_targets` contains `console`, its task projection is also saved and restored across process restarts.
  - The local runtime currently provides topic-aware APIs (`GET /topics`, `DELETE /topics/{topic_id}`) and runs awareness through the shared direct awareness runtime. Periodic heartbeat is optional; `/poke` remains available when heartbeat is disabled.
- Additional remote runtime endpoints can be configured under `console.endpoints` in `config.yaml`. Each `url` is the complete runtime API base URL; new built-in runtime servers use `/runtime`.
- Remote runtime endpoints still use the shared runtime API contract, but topic APIs are only available when that runtime injects `TopicReader` / `TopicDeleter`.
- A remote endpoint whose health payload reports `mode: console` exposes the same target-owned settings as the built-in local Console. The SPA sends those requests through `/api/proxy` to the remote Console's `/runtime` API.
- Task WebSocket frames from a remote Console are relayed by the current Console. The browser never receives the remote runtime token, and task polling remains active as the fallback.

## Message reactions

In Console, `message_react({"emoji":"👍"})` attaches one agent reaction to the user
message that started the calling task. It never selects the newest message and
accepts no explicit target IDs. New or steered messages do not change that target.
The tool checks the originating task's topic and conversation before writing.
Missing, nonexistent, or unauthorized targets return errors; they never fall back
to an emoji reply.

Messages have no reaction initially. Repeating the same emoji is idempotent;
a different emoji replaces the previous reaction. The tool accepts one Unicode
emoji, including flags, skin tones, and joined emoji sequences. Success reports
that the reaction was applied to the originating message. The tool does not create
an assistant message; a separate final text response still appears when provided.

The optional `user_reaction` field on task details and task lists stores the emoji
separately from `result`. It uses the existing Console journal and persistence
settings, so conversation reloads restore the badge. Task WebSocket frames carry
`user_reaction` with `task_id`; the SPA applies it to that task's user bubble.
Polling also reads the field, and remote Console endpoints relay the same frames.
Other channel reaction tools keep their existing behavior. No new configuration
keys are required.

## Restart

Settings that only apply after a restart (`process_restart` and `runtime_restart` fields) show a **Restart now** banner once saved. It calls `POST /api/system/restart`:

- The request is refused with `409` while Console tasks are queued or running, unless it sends `{"force": true}`; the banner then asks before restarting anyway.
- The server shuts down as on SIGTERM: it stops serving, stops managed runtimes and closes stores and MCP servers. Then the process runs the same binary again with the same arguments, environment and working directory.
- On Linux and macOS the binary replaces the program in the same process (`execve`), so the PID does not change and systemd, launchd, Docker and the desktop app keep tracking it: no stop, failure or start-limit count. A binary replaced on disk since startup (an update or a rebuild) is the one that starts.
- On Windows a new process starts and the old one exits; under a Windows service manager, restart the service instead.
- The Console is unreachable for about a second; the page waits until it answers again and reloads.

## Architecture (ASCII)

```text
            +------------------------------+
            | Browser (Console SPA)        |
            | Chat / Tasks / Runtime views |
            +---------------+--------------+
                            |
                            v
            +---------------+--------------+
            | Console Backend              |
            | <base_path>/api + /runtime   |
            | auth / endpoints / proxy     |
            +---------------+--------------+
                            |
         +------------------+-------------------+
         |                                      |
 +-------v--------+                    +--------v---------+
 | Console Local  |                    | Remote Runtime   |
 | in-process     |                    | endpoint(s)      |
 | runtime API    |                    | (from config)    |
 +-------+--------+                    +--------+---------+
         |                                      |
         v                                      v
 +-------+--------------------------------------+--------+
 | daemonruntime handlers                                |
 | /health /overview /tasks /tasks/{id} /topics?        |
 | /state/* /audit/* /contacts/*                        |
 +-------+--------------------------------------+--------+
         |                                      |
         |                                      +--> remote TaskView
         |                                           (MemoryStore or FileTaskStore)
         v
 +-------+-----------------------------------------------+
 | consoleLocalRuntime                                   |
 | per-topic ConversationRunner + direct awareness loop  |
 | + submit/topic orchestration                          |
 +-------+-------------------------------+---------------+
         |                               |
         v                               v
 +-------+--------+            +---------+---------+
 | ConsoleFileStore|            | agent.Engine     |
 | TaskView+Topic  |            | shared runtime   |
 | in-memory view  |            | execution        |
 +-------+--------+            +-------------------+
         |
         v
 +-------+-----------------------------------------------+
 | file_state_dir/journal/events.*.jsonl                 |
 | task/topic facts for ConsoleFileStore replay          |
 +-------------------------------------------------------+
```

## Features

- Overview:
  - endpoint list only
  - endpoint card click selects endpoint and opens `Chat`
  - auto-refresh every 60 seconds
- Setup:
  - dedicated `/setup` route for the minimal Console Local configuration path
  - shown when Console Local is online but local chat is not yet submittable
  - guides the user to finish provider/model/API key config, then refresh status
- Chat (named "Topics" in the navigation and in its own title; the route stays `/chat`):
  - send task directly to current agent
  - left secondary sidebar for topics, with one `New Topic` button, topic switching, current-topic delete, and a hidden system topic toggle exposed by clicking the topic sidebar title five times
  - topic title is seeded from the first prompt; once the new topic's task reaches the queue, a separate background LLM request names it and selects a theme icon from a fixed Phosphor catalog, without waiting for the task's reply
  - initial naming uses only the first user message, keeps its language, and does not invent a subject for greetings; request timeouts, retries, and fallback follow the configured LLM route
  - generated titles and icons are persisted together; failed naming leaves the seed title, later messages do not rename the topic, and background results cannot overwrite a customized title or restore a deleted topic
  - topic items use the selected icon, or a chat icon for old/unknown values; visible pages check metadata every five seconds without resetting topic selection, drafts, or pagination
  - `internal/taskdomain/topic_icons.json` maps theme IDs to descriptions; matching regular-weight Phosphor SVGs live in `web/console-nsh/assets/topic-icons/`, with their MIT license. Topic icons are drawn tinted with the text color. Greetings use a separate waving-hand icon, with specific themes for pets, babies, home and family, food, fitness, music, and travel
  - the Topic panel's `Rename` button (a pencil, beside Delete Topic, on desktop and mobile) opens a rename dialog (a bottom sheet on narrow windows) with the topic's current name in a field (empty for a topic without one), a `Regenerate` button and Save/Cancel. The field takes focus; Enter saves; Escape, Back on Android, the close button, the scrim and Cancel close it without saving
  - `Regenerate` asks `POST /topics/{topic_id}/title-suggestion` for a name and puts it in the field; nothing is saved and the icon is untouched, so closing the dialog leaves the stored name. It generates from the first user message and the latest six conversation turns, preferring recent substantive discussion when the subject changes, and is disabled for a topic without messages. A suggestion that answers after the person typed in the field, or after the dialog was closed or reopened, or the topic or runtime changed, is dropped
  - Save sends the field, trimmed and with runs of white space folded, to `PUT /topics/{topic_id}/title` (at most 72 characters). A blank name is not saved (Save is disabled; Enter says why). A saved name is the person's: it counts as customized and moves the title revision on, so first-message naming and an earlier regeneration do not overwrite it, and the topic keeps its icon. Failed suggestions and saves show the error in the dialog and keep what was typed; a second press while one is under way sends nothing, and a save under way holds the dialog open until it answers
  - name generation excludes slash commands, reasoning, tool logs, and incomplete replies. Each user message is capped at 600 characters and each completed assistant reply at 400; the total naming input is capped at 8,000 characters
  - `POST /topics/{topic_id}/regenerate-title` still regenerates and saves a name and icon in one step (the Console uses it for a TODO item's icon, and `/topic title regenerate` in the remote chat). It keeps the current name and icon until success, rejects duplicate requests for the same topic, and leaves them unchanged on failure. A title revision prevents late results from overwriting subsequent edits or deletion; starting regeneration also invalidates pending initial naming. Empty and system topics cannot be regenerated
  - topic-scoped `ChatHistoryItems` style list
  - what other agents send the local agent over Agent Link is kept in one topic per agent (`_agentlink_<instance_id>`, named after the agent). The sidebar's agents button (shown once such a topic exists) lists them with each agent's avatar, the latest first; the date and tag views leave them out. An agent's topic is read-only: a note replaces the composer, and it cannot be renamed, tagged or deleted
  - each TODO (cron) item's runs are kept in a topic of its own (`_cron_<task_id>`, named after the item); the heartbeat stays in Awareness. Runs from before this were recorded in Awareness and stay there. The topic is renamed with the item: when the item is saved in TODO, and otherwise at its next run. The sidebar's TODO button (an alarm clock, always shown) lists them, the latest run first, and the list follows new runs. Each has a second row with the provider and model its item runs with (`OpenAI · gpt-5.2`), read from `/todo/tasks` while the list is shown: the item's LLM profile, or the default route when it names none or one that is no longer configured; an item that is gone (a one-time item that has run, or a deleted one) shows what its latest run used, or `No longer scheduled` when no run recorded it; before any item has run, the list is empty and says so, and pressing the button again returns to the date list; the date and tag views leave them out. The sidebar is shown for them even when there is no other topic. An item's topic is read-only: a note replaces the composer, the runtime refuses a task submitted to it, and it cannot be renamed, tagged or deleted. Its title is the item's; its icon is generated from the item's task at its first run, the way a person's topic gets one, with an alarm clock until then. The right panel's regenerate button redoes the icon alone, and there is no rename or delete button. The panel's Workspace tab shows the workspace the item's runs use, read-only, and is hidden when there is none: the item's `workspace_dir` (source `todo`), else the default workspace, and for an item that is gone, the one its latest run was given. `PUT` and `DELETE /workspace` refuse a TODO item's topic with `400`. Each run records its context under the topic, for the Window Used row and its inspector. While it is open, it checks for new runs every 5 seconds
  - receive task progress over WebSocket for local and remote Console endpoints, with `/tasks/{id}` polling as fallback
- Tasks:
  - list + detail (read-only)
- Files:
  - `cron.yaml`, `identity.yaml`, `soul.md` and `HEARTBEAT.md` are rows of `agent.db`; their routes render them in the file shapes and parse a save back (for one release)
- TODO runs:
  - while a saved item runs, its editor's head shows Stop (desktop, the calendar's panel and the phone editor alike). It stops that one execution, named by the `run_id` from `/todo/runs`, through `POST /todo/tasks/{id}/stop`; the item, its schedule and its later runs are left alone, and what the run already did is not undone. Idle, waiting and unsaved items and the heartbeat show no Stop
  - after the press the button reads Stopping… and is busy (a second press sends nothing) until `/todo/runs` (asked every second meanwhile) reports how that run ended: `Stopped "…"` only once it ended stopped, `"…" finished before it could stop` (or `failed`) when it ended on its own first. The last-run line follows (`· Stopped`). A run another client is stopping shows Stopping… too. A failed request says why and leaves Stop to press again; a run the runtime no longer holds says it is no longer running. A later run of the item has a Stop of its own
- Heartbeat (in TODO):
  - the heartbeat's workflows, one card each: a title, a switch (an off workflow is kept but not run) and Markdown instructions; add, move up or down, delete; Save replaces the list
- Contacts:
  - dedicated sidebar entry
  - structured list from the `contacts` table (`agent.db`)
  - status filter (`all|active|inactive`)
  - circular cached avatars with a stable initial fallback; local and remote endpoints use the same authenticated proxy path
- Audit:
  - browse Guard audit files
  - cursor-based reads for large JSONL logs (`limit` + opaque `cursor`)
  - newest entries shown first in the UI
  - entries grouped by `run_id` for easier review
  - `OutputPublish` audit events mark `body_omitted_from_audit: true` in the raw JSONL when the final body is intentionally not persisted
  - Guard keeps `guard_audit.jsonl` as the canonical ledger and may emit per-decision mirrors such as `guard_audit.allow_with_redaction.jsonl`, `guard_audit.require_approval.jsonl`, and `guard_audit.deny.jsonl`
- Settings:
  - language selector
  - logout button (danger style)
  - entry moved to top-right, next to endpoint switcher
  - Agent, Tools, Skills, Persona, Channels, Managed Runtimes, Guard, update checks, and provider account actions target the selected Console endpoint
  - language and logout remain browser-host actions and do not target a remote endpoint
  - agent tool toggles mirror `config.yaml` structure under `tools.<name>.enabled`
  - the Settings page now exposes the `spawn` toggle together with the other agent tools
- Keyboard shortcuts:
  - a few actions (new topic, topic search, the message field, the pages, the sidebar) have keyboard shortcuts, with different defaults in a browser and in the desktop app; Settings → Keyboard shortcuts lists and changes them, saved per environment in the Console's local values. See [Keyboard shortcuts](console/keyboard-shortcuts.md)
- i18n:
  - English, Chinese, Japanese
  - language selector appears on Login and Settings (not in top nav)

## API Surface (under `/api`)

Auth:
- `POST /auth/login`
- `POST /auth/logout`
- `GET /auth/me`

Console settings:
- `GET /settings/agent`
- `PUT /settings/agent`
- `POST /settings/agent/models`
- `POST /settings/agent/test`
- `GET /settings/console`
- `PUT /settings/console`
- `GET /settings/auto-update`
- `PUT /settings/auto-update`
- `POST /settings/auto-update/check`
- `GET /settings/tools/schemas`: built-in tools' descriptions and parameter schemas, with channel tools per channel, for the Tools page.
- `POST /system/restart` (`{"force": false}`): restarts this Console process; see [Restart](#restart).

Notifications:
- `GET /notifications/ws?ticket=…`: the live notification socket the web and desktop Console notify from (TODO items' opt-in notifications and topic task completions).
- `GET /notifications/events`: the topic task completions of the last 24 hours (at most 256), for a client that was not connected when they happened: the Android app's background watcher. Query: `epoch` and `after` (the cursor of an earlier answer of this server start), else `since_ms` (how long the client has been away, by its own clock); `wait` (seconds, at most 50) holds an answer with no completion until the next one. Answers `{"epoch","cursor","active","events":[{"id","type","topic_id","status"}]}`, where `active` counts the chat tasks still queued or running. The same completions as the socket's: never a TODO item's run, Awareness, Agent Link or a steer; identifiers and status only. Needs a Console session.
- `/auth/codex/*`
- `/auth/xai/*`
- `/auth/pro/*`

Settings payload note:
- The `tools` object mirrors the config tree, for example `tools.spawn.enabled` and `tools.bash.enabled`.

Dashboard/system:
- `GET /endpoints`
- `GET /proxy?endpoint=<ref>&uri=<runtime-path>`

Tasks:
- `GET /proxy?endpoint=<ref>&uri=/tasks?limit=<n>[&cursor=<opaque>]`
- `POST /proxy?endpoint=<ref>&uri=/tasks`
- `GET /proxy?endpoint=<ref>&uri=/tasks/{id}`
- `GET /proxy?endpoint=<ref>&uri=/topics?limit=<n>[&cursor=<opaque>]`
- `DELETE /proxy?endpoint=<ref>&uri=/topics/{topic_id}`
- `POST /proxy?endpoint=<ref>&uri=/topics/{topic_id}/regenerate-title`
- `PUT /proxy?endpoint=<ref>&uri=/topics/{topic_id}/title` with `{"title"}`
- `POST /proxy?endpoint=<ref>&uri=/topics/{topic_id}/title-suggestion`
- `GET /proxy?endpoint=<ref>&uri=/topics/activity`
  - the topics with unfinished tasks: `{"topics":[{"id","status","running","pending","cron_running"}]}`, where `status` is `pending` when a task waits for the person (an approval or a question), else `running`. `running` counts queued and running tasks; `cron_running` (left out when zero) counts only the TODO items' runs running now, by the trigger recorded with each run, whether their schedule or Run now started them; queued runs do not count. The Chat view polls it every 5 seconds while visible and shows a status mark at the right of each such topic, the square mark used across the Console: breathing between hollow and filled blue for running, filled orange for pending. A topic whose task finished while it was not being viewed keeps a filled blue mark until it is viewed. While any topic's `cron_running` is above zero, the TODO runs toggle in the topic list's header carries the same running mark on its alarm icon, and its tooltip and accessible name give the count (for example "TODO runs — 2 running"), whether or not the toggle is on and whichever topic is open. A failed poll keeps the last count; switching to another runtime clears it until that runtime answers.

Notes:
- Topic APIs are guaranteed on `Console Local`; other runtimes may return `503` if they do not expose topic readers/deleters.
- Renaming (`PUT .../title`) returns the renamed topic; it returns `400` for a blank or over-long title and for a system or TODO item topic, and `404` for a missing topic. A title suggestion returns `{"title","icon"}` and changes nothing; it returns `400` for a topic without conversation or a system or TODO item topic, `404` for a missing topic and `503` for generation failure, and like regeneration it uses the configured LLM timeout rather than the proxy timeout.
- Regeneration returns the updated topic, including its title, icon, and `title_revision`. It returns `400` for an empty or system topic, `404` for a missing topic, `409` for an in-flight request or concurrent title change, and `503` for generation failure or an unsupported runtime. It uses the configured LLM request timeout, retries, and fallback, not the ordinary 20-second proxy timeout; disconnecting cancels the request.

Runtime routes used through `/proxy`:
- Selected Console settings:
  - `GET|PUT /settings/agent`
  - `POST /settings/agent/models`
  - `POST /settings/agent/test`
  - `GET|PUT /settings/console`
  - `GET|PUT /settings/auto-update`
  - `POST /settings/auto-update/check`
  - `/auth/codex/*`, `/auth/xai/*`, `/auth/pro/*`
- Overview/runtime:
  - `GET /overview`
- Files (rendered from and parsed back into `agent.db`; kept for one release):
  - `GET /state/files`
  - `GET /state/files/{name}` (`cron.yaml|identity.yaml|soul.md|HEARTBEAT.md`)
  - `PUT /state/files/{name}`
  - `GET /persona/files`
  - `GET /persona/files/{name}` (`identity.yaml|soul.md`)
  - `PUT /persona/files/{name}`
  - `GET|PUT /todo/files/cron.yaml` (the TODO list as `cron.yaml` text)
- Persona and heartbeat:
  - `GET /persona/identity`: `{exists, identity}`, the identity with `soul` and `extra`
  - `PUT|PATCH /persona/identity`: change the fields the body names (`name`, `name_alts`, `creature`, `vibe`, `emoji`, `soul`, `extra`)
  - `GET /heartbeat/workflows`: `{items, task, task_empty}`, in order, with the task a tick would run
  - `PUT /heartbeat/workflows` `{"items": [...]}`: replace the list in that order (an item with an `id` keeps its row)
  - `POST /heartbeat/workflows`: add one (at `position` when given)
  - `GET|PATCH|DELETE /heartbeat/workflows/{id}`: one workflow (`title`, `instructions`, `enabled`, `position`)
  - `GET /persona/avatar`
  - `PUT /persona/avatar`
  - `DELETE /persona/avatar`
- Contacts (the whole-file `/contacts/files/*` routes are removed; `/contacts/item` edits one contact's YAML):
  - `GET /contacts/list?status=all|active|inactive`
  - `GET /contacts/avatar?contact_id=<contact_id>`

`/contacts/list` may return an endpoint-relative `avatar_url` for a Contact whose cached avatar exists. The URL is derived state and is not written to Contact YAML. Console fetches the image through the selected endpoint, so a remote Contact avatar is never read from the local runtime by mistake.
- Audit:
  - `GET /audit/files`
  - `GET /audit/logs?file=<name>&limit=<n>[&cursor=<opaque>]`

Paginated runtime lists return `items`, `limit`, `has_next`, and optional `next_cursor`.

## Security and Caching Notes

- Console password is required (`console.password` or `console.password_hash`).
- Protected APIs require Bearer token auth.
- Anti-bruteforce protection is enabled in the backend.
- JSON API responses use no-store cache headers.
- SPA fetch requests use `cache: "no-store"`.

## Setup Wizard

- When no readable `config.yaml` is found, `morph install` starts an interactive setup wizard.
- The wizard now includes Console setup inputs:
  - `console.listen`
  - `console.base_path`
  - `console.password`
  - first `console.endpoints[]` entry (`name`, `url`, `auth_token` env var name)
- After input, wizard prints:
  - generated Console config snippet
  - suggested env var names
  - endpoint health probe result (`GET <endpoint>/health`)
- If the endpoint URL is local loopback (`localhost` / `127.0.0.1` / `::1`), wizard auto-generates a runtime auth token and uses `MISTER_MORPH_SERVER_AUTH_TOKEN` for endpoint auth.

## Build (production static)

1. Build the Console and stage it as the CLI/backend binary's embedded assets
   (`scripts/build-backend.sh` does both, then builds the binary):

```bash
web/console-nsh/scripts/build-web.sh
./scripts/stage-console-assets.sh
```

3. Start console backend + static hosting:

```bash
MISTER_MORPH_SERVER_AUTH_TOKEN=dev-token \
MISTER_MORPH_ENDPOINT_TELEGRAM_TOKEN=dev-token \
MISTER_MORPH_CONSOLE_PASSWORD=secret \
go run ./cmd/mistermorph console
```

Example `config.yaml` snippet (`console.endpoints` is optional now):

```yaml
server:
  auth_token: "${MISTER_MORPH_SERVER_AUTH_TOKEN}"

console:
  endpoints:
    - name: "Telegram"
      url: "http://127.0.0.1:8787/runtime"
      auth_token: "${MISTER_MORPH_ENDPOINT_TELEGRAM_TOKEN}"
```

4. Open:

`http://127.0.0.1:9080/`

## Dev

1. Build the Console into a folder and serve it from there, so a rebuild shows on reload:

```bash
web/console-nsh/scripts/build-web.sh /tmp/morph-console
./scripts/stage-console-assets.sh /tmp/morph-console
MISTER_MORPH_CONSOLE_PASSWORD=secret \
MISTER_MORPH_SERVER_AUTH_TOKEN=dev-token \
go run ./cmd/mistermorph console --console-static-dir /tmp/morph-console
```

2. Open `http://127.0.0.1:9080/`. After changing the Console, run `build-web.sh` again and reload.

   For hot reload instead, keep a Console running (`morph console`, on `127.0.0.1:9080`), run
   `scripts/dev-console.sh` and open `http://127.0.0.1:9082/`: a saved change shows at once,
   without a rebuild or reload. It runs nsh's web dev server and a proxy that puts the page and
   that Console's `/api` on one origin; Ctrl-C stops both. `API` points it at another Console,
   and `DEV_PORT` and `NSH_PORT` change its ports.

3. Check and test the Console:

```bash
cd web/console-nsh
nsh check
nsh test --web-host tests/noHost.js
```

Notes:
- If you omit `--console-static-dir`, `console` falls back to its embedded SPA assets.
- `./scripts/stage-console-assets.sh` is required before `go run ./cmd/mistermorph ...`, because the CLI validates embedded Console assets at startup.
- Optional external endpoints should point to an existing channel runtime such as `morph telegram`, `morph slack`, `morph line`, or `morph lark`.


## Shared topics in the terminal

`mistermorph chat` (or `morph`) executes locally. It does not start Console,
bind `console.listen`, or require a runtime token. Start `morph console`
separately to use the Web UI.

Chat and Web share topic IDs, tasks, replies, workspace attachments, and context
checkpoints when they use the same `file_state_dir` and `tasks.dir_name`, with
`console` enabled in `tasks.persistence_targets`. Disabling persistence also
disables cross-process history sharing. Chat does not change this setting.

The first message creates a topic. `/topics` opens the same topic picker used
for explicit remote connections, filtered by the current workspace. Use
`/topic switch <id>` or `chat --topic <id>` to open an existing topic, including
one outside the picker scope. Selecting a topic restores its history with the
normal chat presentation. `/topic history` reads the latest saved history;
`/topic history more` loads older entries. Each new local turn reads shared
history again, including messages added by Web.

The task store refreshes its projection from the journal under a process-shared
file lock before reads and writes. Chat does not run Console's restart recovery.
A live chat session holds a separate ownership lock so starting Console cannot
cancel its tasks. When that session exits unexpectedly, subsequent store access
marks its unfinished tasks canceled. Different topics can execute independently.
While a topic is active in chat, another executor cannot start a turn or delete
that topic. Stop and approve local tasks in their owning terminal.

Ordinary chat accepts local execution flags such as `--model` and `--workspace`.
`--standalone` is a hidden compatibility alias, with the same topics and UI.
Local `/exit` and `/quit` cancel the current task and save the outcome. They do
not stop a separately running Console. Local topic switching and context-changing
commands wait until the current task or approval finishes.

`<file_state_dir>/stats/topics_projection.json` remains a derived list cache.
Local chat reads the shared task store, so this cache is not its history source.

The remaining connection details apply when `--runtime-url` is explicitly set.

To connect to an explicit address with `--runtime-url`, enable that Console's
public runtime API with `server.auth_token`, then set
`MISTERMORPH_RUNTIME_TOKEN` to that Console's `server.auth_token` using your
shell/secret manager. Explicit URLs never inherit automatic local credentials or
the local configuration token. Do not put the token in a URL or CLI flag.

```bash
mistermorph chat
mistermorph chat --topic <topic-id>
mistermorph chat --runtime-url http://127.0.0.1:9080/runtime
mistermorph chat --runtime-url https://morph.example.com/morph/runtime --topic <topic-id>
```

Use the full runtime API base URL, including any reverse-proxy prefix. Non-loopback
connections require HTTPS. This connects directly to `/runtime`, not the browser
session/proxy API. Connection failure never starts a local agent. Explicit local
provider/model/skills/execution overrides and `--workspace`/`--no-workspace` cannot
be combined with `--runtime-url`. In remote chat, use `/workspace` to set the
server workspace.

In connected mode, `/topics` opens the picker and queries the runtime API.
The picker shows topics in the **server-resolved current workspace**, never the
client's working directory. Arrow keys move selection;
Enter opens the selected topic or activates the New topic / Load more row; Esc returns to the previous conversation and its draft. Type to
filter loaded titles/IDs, Ctrl+L loads more, Ctrl+R refreshes the fixed workspace,
Ctrl+S prints the full endpoint/workspace/status, and Ctrl+N starts a local draft in that workspace. The first message creates the
server topic. There is no empty-topic creation API. Topics outside the picker scope
remain accessible via `/topic switch <id>`.

| Command | Explicit remote connection behavior |
| --- | --- |
| `/topic new` | Resume the single new-topic draft, or start one without creating server state |
| `/topic switch <id>` | Validate and load an existing topic; failure preserves the current view |
| `/topic history [more]` | Redisplay loaded history / load the next older page |
| `/workspace` | Read server workspace (draft: show pending path/default intent) |
| `/workspace attach <path>` | Bind an existing topic on the server, or stage a path for the draft's first send |
| `/workspace detach` | Remove attachment; resolve server default, **not** disable workspace |
| `/status` | Full endpoint/topic/workspace and server context metadata |
| `/stop` | Explicitly stop tasks for the selected topic only |
| `/models`, `/skills`, `/think`, `/ctx` | Execute the Console runtime command in the current topic; `/ctx` requires an existing topic |
| `/reset` | Clear model context and its checkpoint, retaining shared chat history |
| `/init`, `/update` | Create/read or regenerate AGENTS.md in the server workspace |
| `/approve`, `/deny` | Resolve the pending approval through Console; y/n also works in the panel |
| `/agents`, `/agent`, `/subagents` | Inspect retained child execution records; Ctrl+G opens the same view |
| `/topic title regenerate` | Server-generated title, not manual rename |
| `/topic delete` | Confirm with y; server deletion also stops tasks and cleans up context |
| `/exit`, `/quit` | Disconnect without stopping server tasks |

Paths are interpreted on the **server**. Drafts are kept per topic only until the
client exits. Switching away or losing the connection does not stop tasks.
Esc or Ctrl+C while running stops tasks in the current topic, as does `/stop`.
Unknown submission outcomes are never automatically retried: inspect `/topics` and
history before sending again, especially after first-topic creation. A draft with
an unresolved creation remains blocked to prevent duplicate topics. Pending tasks
show the common approval panel; decisions in either terminal or Web apply to the
same server task. Approving resumes it, and denying rejects the pending action.

HTTP polling (normally every 3 seconds, backing off to 30 seconds on errors)
remains authoritative. WebSocket snapshots add multiline text/reasoning previews,
plan steps, recent activity and current activity for up to four active tasks in the
selected topic; other tasks remain
HTTP-tracked. Stream failures retry with backoff without interrupting polling.
Switching views or exiting closes subscriptions without stopping server tasks.
HTTP terminal results replace previews, so final answers are not printed twice.
Progress is bounded and clipped to terminal dimensions, keeping the composer
visible. Text/reasoning remain snapshot previews. Execution records are appended
to the transcript and retained with completed or pending tasks: tool parameters
and output, plan steps, file diffs, retries, and child-agent events. Reconnecting
uses record sequence numbers to avoid printing the same events twice. Retention
is bounded; see [terminal chat](chat.md#inspect-subagents) for limits. Older tasks
without execution traces restore their saved plans and tool activities alongside
their replies. Details that were never stored cannot be recovered.
Polling discovers other clients' new tasks,
title/workspace changes and deletion, including after the last task finishes.
Loaded history uses the normal chat presentation: `❯` for user messages and
Markdown for replies. Task IDs and successful completion statuses stay out of
message text; errors and approval requests appear separately. `/topic history`
gives the canonical loaded projection, including steering instructions. The `/` command
menu and `$` skill menu use the common chat UI; skills are read from Console.
Input recall history is saved locally, including multiline input. `/status` uses
the normal labelled display, and the startup header shows the provider and model.
The Console process must also be updated for the restored commands and records.
Remote chat does not read local topic files or import terminal input history.
Server persistence settings still apply. See the [design](feat/feat_20260917_tui_shared_topics.md)
for storage and execution boundaries.

## State Storage

The agent's state is in SQLite, next to the journal and the memories (see `docs/feat/feat_20261108_agent_db.md`):

- `<file_state_dir>/agent.db`: the config (unless `--config` names a file), the identity and soul, the heartbeat workflows, contacts (with an index of every channel identifier), the contacts bus inbox and outbox, the TODO list, Console login sessions, Agent Link peers, and each conversation's context use, latest request snapshot and workspace.
- `<file_state_dir>/usage.db`: LLM usage, one row per call (`stats.llm_usage.retention_days` bounds it); also the coder tool's runs and the last subscription quota of each coding CLI (`coder_quota`).

Each change is one transaction; there are no lock files for these stores (the TODO scheduler keeps `locks/cron.scheduler.lck`). The files an older version kept (`config.yaml` at the default path, `persona/identity.yaml`, `persona/soul.md`, `HEARTBEAT.md`, `contacts/ACTIVE.md`, `INACTIVE.md`, `bus_inbox.json`, `bus_outbox.json`, `cron.yaml`, `console/sessions.json`, `agentlink/peers.json`, `topics/*/context*.json` and `workspace.json`, `stats/llm_usage/*.jsonl`) are imported the first time the database opens after the config is loaded (so a custom `contacts.dir_name` is honoured) and renamed `*.imported`; a record that does not parse is skipped and listed in the database's `meta` table under `import_rejects:<store>`.

The Console's System settings say where the config is kept. Use `morph state export <dir>` and `morph state import <dir>` to work on the state as files, `morph config export|import|edit` for the config alone, and `morph state snapshot <dir>` for backups. `morph state import` changes only what the folder has a file for: a missing file leaves its store as it is, and `contacts/ACTIVE.md` without `INACTIVE.md` replaces the active contacts and keeps the inactive ones (and the other way round).
