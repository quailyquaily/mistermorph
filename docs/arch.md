# MisterMorph Architecture

## 1. System Architecture

```text
                           +-------------------------+
                           |      User Surface       |
                           | CLI / Console / Channels|
                           +------------+------------+
                                        |
                   +--------------------+--------------------+
                   |                                         |
         +---------v---------+                     +---------v---------+
         | CLI bootstrap     |                     | integration API   |
         | cmd/mistermorph/* |                     | integration/*     |
         +---------+---------+                     +---------+---------+
                   |                                         |
                   +--------------------+--------------------+
                                        |
                           +------------v------------+
                           | Runtime Assembly Layer  |
                           | config snapshot + deps  |
                           +------------+------------+
                                        |
      +-----------------+---------------+--------------------+------------------+
      |                 |                                    |                  |
 +----v-----+   +-------v--------+                    +------v------+   +------v-------+
 | One-shot |   | Channels       |                    | Console     |   | Heartbeat    |
 | runtime  |   | event workers  |                    | local runtime|  | scheduler    |
 | run      |   | (bus-driven)   |                    | + runtime API|  | periodic chk |
 +----+-----+   +-------+--------+                    +------+-------+   +------+-------+
      |                 |                                      |                  |
      +-----------------+-------------------+------------------+------------------+
                                        |
                          +-------------v--------------+
                          | channelruntime/core        |
                          | runner + task lifecycle    |
                          +-------------+--------------+
                                        |
               +------------------------+------------------------+
               |                                                 |
      +--------v--------+                              +---------v----------+
      | agent.Engine    |                              | daemonruntime      |
      | prompt/tools/LLM|                              | HTTP/store adapters|
      +---+---------+---+                              | taskdomain port    |
          |         |                                  +---------+----------+
 +--------v--+   +--v--------+                                   |
 | llm.Client|   | tools.Reg |                                   v
 +-----+-----+   +-----+-----+                        +----------+-----------+
       |               |                              | file_state_dir/journal |
 +-----v-----+   +-----v------------------+           | events.*.jsonl        |
 | providers |   | builtin/tools/adapters |           +----------------------+
 +-----------+   +------------------------+
Cross-cutting: guard, skills/prompt blocks, inspect dump, bus idempotency, HEARTBEAT.md
```

## 2. Execution Flows

### 2.1 Main Agent Run Flow (Registry Path)

```text
task/event
  -> build prompt/messages/meta
  -> build tool registry + llm tools
  -> agent.Engine.Run
     -> step loop
        -> LLM call (with tools)
        -> parse (plan | tool_call | final)
        -> tool execute (when tool_call)
        -> update plan/history/metrics
     -> if limits reached: force finalization request
     -> final output (guard redact if needed)
```

This is the primary execution path shared across entrypoints; independent non-registry requests are listed in 2.2.

Tools in this flow:

- Main step-loop LLM requests use runtime registry tools (`buildLLMTools(registry)`), including static and runtime-injected tools available in that runtime.
- The force-finalization fallback request uses no tools.

### 2.2 Independent LLM Requests (Non-Registry Path)

These requests are executed outside the normal agent step loop tool-registration path.

Agent / Plan tools:

- Forced finalization request when step/token limits are reached.
  tools: `none`
  files: `agent/engine_helpers.go`
- Plan generation request inside the `plan_create` tool implementation.
  tools: `none`
  files: `builtin/plan_create.go`

Telegram:

- Group-addressing decision request (this path injects local `message_react` for the addressing loop when context allows, and does not expose runtime registry tools).
  tools: `message_react` only when context allows; otherwise `none`
  files: `telegram/runtime.go`, `telegram/trigger.go`, `telegram/trigger_addressing.go`
Slack:

- Group-addressing decision request (this path can inject local `message_react` for the addressing loop when context allows, and does not expose runtime registry tools).
  tools: `message_react` only when context allows; otherwise `none`
  files: `slack/trigger.go`

LINE:

- Group-addressing decision request (this path can inject local `message_react` for the addressing loop when context allows, and does not expose runtime registry tools).
  tools: `message_react` only when context allows; otherwise `none`
  files: `line/trigger.go`

TODO semantics / references:

- Reference-id rewrite, complete-target semantic match, and WIP dedupe keep-index selection.
  tools: `none`
  files: `builtin/job_manage.go`, `todo/reference_llm.go`, `todo/semantic_llm.go`, `todo/ops.go`

Skills / installer:

- Remote skill installation safety-review request (extract download files and risks from untrusted SKILL content).
  tools: `none`
  files: `skillscmd/skills_install_builtin.go`

## 3. Two Runtime Families

### 3.1 One-shot (`run`)

```text
CLI command -> config/registry/guard setup -> agent.Engine.Run -> output/json
```

- Entrypoint: `cmd/mistermorph/runcmd/run.go`
- Characteristics: one task execution with no platform event consumer loop. Console and channel runtimes own their queues separately.

### 3.2 Channels Runtime Family

```text
platform event
  -> inbound adapter
  -> inproc bus
  -> per-conversation worker (serial)
  -> run*Task -> agent.Engine
  -> outbound publish
  -> delivery adapter
  -> platform send
```

- Channels runtime: `internal/channelruntime/{telegram,slack,line,lark}/*`
- Shared channels core: `internal/channelruntime/core/*`

## 4. Existing Topic Docs (Links Only)

The following areas already have formal docs, so this file only links them:

- Prompt system: [`./prompt.md`](./prompt.md)
- Tools system: [`./tools.md`](./tools.md)
- Security / Guard: [`./security.md`](./security.md)
- Skills system: [`./skills.md`](./skills.md)
- Heartbeat feature notes: [`./feat/feat_20260204_heartbeat.md`](./feat/feat_20260204_heartbeat.md)
- Telegram runtime behavior: [`./telegram.md`](./telegram.md)
- Slack Socket Mode: [`./slack.md`](./slack.md)
- LINE webhook runtime: [`./line.md`](./line.md)
- Bus design and implementation: [`./bus.md`](./bus.md), [`./bus_impl.md`](./bus_impl.md)

## 5. Key Areas Without Standalone Docs

### 5.1 Integration Embedding Layer

```text
host app
  -> integration.DefaultConfig + Set(...)
  -> rt := integration.New(cfg)      // snapshot at init
  -> rt.RunTask(...)                 // one-shot
  -> rt.NewTelegramBot/NewSlackBot   // long-running
```

Notes:

- `integration` is the third-party reuse entrypoint; host apps do not need to depend on CLI command wiring.
- `integration.New(cfg)` builds a snapshot of effective runtime config at initialization time.
- Code: `integration/runtime.go`, `integration/runtime_snapshot*.go`, `integration/channel_bots.go`

### 5.2 Awareness Runtime Path

```text
cron loop built-in __heartbeat__ OR authenticated POST /poke
  -> awarenessutil.Tick(state, behavior, buildTask, enqueueTask)
  -> behavior=heartbeat: BuildHeartbeatTask(HEARTBEAT.md)
  -> behavior=poke: request body becomes task text
  -> awareness meta envelope (trigger=heartbeat|poke)
  -> agent.Engine.Run (normal tools/skills enabled)
  -> summary output (runtime-defined sink, e.g. logs/chat)
```

Notes:

- Awareness shares the same agent execution core; it differs mainly by trigger path and metadata envelope.
- Heartbeat is registered as the built-in cron task `__heartbeat__` when both `cron.enabled` and `heartbeat.enabled` are true.
- If `cron.enabled` is false, Heartbeat does not run.
- The cron loop runs up to `cron.max_concurrency` TODO items at once (default 8); items beyond it wait in order. An item never overlaps itself: an occurrence that comes due while the same item is still waiting or running is skipped, and a manual run returns `409 Conflict`. Heartbeat runs in a lane of its own beside them, so long TODO items do not hold it up. On shutdown, running items get the cancelled context and are waited for; queued items are logged as `cron_skip` with `reason=shutdown`.
- `GET /todo/runs` (and the `runs` field of `GET /todo/tasks`) lists the items the loop has running or queued now; the Console TODO panel polls it to mark them. Each entry has a `run_id` naming that one execution (a later run of the same item gets another) and `stopping` once a stop was asked for. `GET /todo/runs` also lists how the process's last 64 executions ended (`finished`: `id`, `run_id`, `status` `done|failed|canceled`, `stopping`, `finished_at`).
- `POST /todo/tasks/{id}/stop` `{"run_id": "..."}` stops that execution only: each run has a context of its own, cancelled with the cause `stopped by user`, which ends its agent run (LLM calls, tools). A queued execution is dropped before it starts. The answer reports the execution's state, not the stop's success: `202` `stopping` while it winds down (asking again only repeats that), `200` with how it already ended (`done`, `failed`, `canceled`), `404` `not_found` for an ID this process does not hold (a stale or another process's run), `400` without `run_id`. A run that completes anyway ends `done`: the run's end decides, not the request. A stopped run is recorded as `canceled` (the item's `last_run_status`; the run's task record `canceled`, error `stopped by user`), and what it already did is not undone. The item, its schedule and its later runs are untouched; a one-time item stopped at or after its time is kept, but its past time does not fire it again (a failed one retries, with the waits below) until it is given a new time or run manually.
- A one-time (`at`) schedule whose run fails is tried again after 1, 5, 15 and 60 minutes, each counted from the end of the failed try: five tries in all. After the fifth fails, the schedule fires no more; the job is kept as it is, with `last_run_status` `failed`, the error on its last history row, and a `warnings` entry in `GET /todo/tasks`. A failed try's history row says where it stands in its `note` (`one-time schedule: try 2 of 5 failed; the next try is in 5m0s`, and for the last `...; it will not be tried again. Set a new time or run the job by hand.`). A try counts when the run was started by that schedule at or after its time and ended `failed`, or `skipped` because an input it needs fresh did not finish; runs started by a person, a poke, a message or another job never count, and a run that ends `done` spends the schedule as before. A new time starts the count afresh, since the earlier failures were queued before it. The count is read from the run history, so it survives a restart.
- A job has a list of `triggers`, each with a stable `id` and a `kind`: `schedule` (`at` or `cron`, and `tz`), `poke` (nothing more) or `message` (`channel`, `chat_id`: a message in that chat starts the job, see below). The scheduler fires a job on any of its schedule triggers, once per tick; a job without one is never due by the clock. The job's own `at`, `cron` and `tz` stay as a mirror of its first schedule trigger, for clients that know only them. A job stored before triggers reads back with one schedule trigger (`trg-schedule`). On `PUT /todo/tasks`, a task sent with `triggers` is taken as written; a task sent without it is a legacy write: `at`, `cron` and `tz` are its schedule, and the stored job's other triggers, its `uses` and its `join` are kept. A one-time (`at`) trigger that has run is spent: the job is deleted with it, as one-time items always were, unless the job has another trigger or another job uses it; then only the trigger is removed.
- A job may use other jobs: `uses` is a list of `{job_id, mode}` (`latest`, `each` or `fresh`; at most 8), and `join` is `all` (the default) or `any`. A `fresh` use may carry `max_age`, a Go duration such as `"30m"`, `"1h"` or `"24h"` (1 minute to 720 hours; `1h` when left out). A save is refused with `400` and a text a client can show for an unknown `job_id`, a job that uses itself, a loop (named: `a -> b -> a`), a job used twice, more than 8 uses, an unknown `kind`, `mode` or `join`, and a `max_age` that is not a duration, is out of range, or sits on a use that is not `fresh`. A job that others use cannot be deleted: the refusal names them.
- Every run of a job that uses others, whatever started it, is given each used job's definition and a result of it, through the job-reference machinery (`internal/jobrefs`): the same block of read-only source data, limits, exclusions (no environment values, workspace, model profile or delivery target) and access rule as a `[label](job:<id>)` link, without a link in the text. A job that is both linked and used is given once; a used job carries `used_as` (`latest`, `each`, `fresh`). A used job the job may not read (see Job references: a job that reports to a chat reads only jobs that report to that chat) fails the run, as an unusable link does. Which result: `latest` gives the latest finished output; `each` and `fresh` give the output of the input's run in this run's own chain (same `origin_run_id`) when that run left a usable record (`result.from_this_chain: true`), and otherwise the latest, with the note saying so and when it was made. The history row of a run names the task record that keeps its output (`task_id`).
- `fresh`: before the run starts, each `fresh` input is looked at, in the worker that holds the run, which stays `queued` meanwhile. An input whose latest `done` run ended within `max_age` is used as it is. Otherwise the input is run first, in the same worker (it takes no slot of its own), recorded with cause `job`, `from_job_id` the job that asked, the same `origin_run_id` and the note `run for a fresh result that job <id> needs`; the dependent starts when it ends `done`. Within one chain an input is run for a fresh result at most once: a later job of the chain uses that run, or is skipped if it did not end `done`. An input that is already queued runs at once in the waiting worker, in place of its turn in the queue; one that is already running is waited for, at most 30 minutes. Neither is started twice. The dependent is recorded as `skipped`, its note naming the input, when the input failed, was canceled or was skipped, is switched off (it is not started), is gone, would make the chain more than 5 jobs deep, or was still busy after the wait; the jobs that use the dependent with `each` are then skipped down the chain (`input job <id> was skipped`). A skipped job never started: its `last_run_at` and `last_run_status` are unchanged. A run an input makes for a fresh result is bounded by the task timeout, as every run is, not by the 30 minutes.
- Every run of a stored job is recorded in agent.db (`job_runs`): `run_id`, `job_id`, `status` (`queued`, `running`, `done`, `failed`, `canceled`, `skipped`), `queued_at`, `started_at`, `finished_at`, a short `error`, and its `cause`: `kind` (`schedule`, `manual`, `poke`, `message`, `job`), `trigger_id`, `from_job_id`, `origin_run_id` (the run that started the chain; a run that starts one is its own origin) and `note`. The newest 200 runs of each job are kept, and none older than 180 days; the heartbeat's runs are not recorded. `GET /todo/runs/history` lists them, newest first, by `job_id`, `from`, `to` (RFC 3339, on `queued_at`; `to` is exclusive) and `limit` (50 by default, 500 at most). The entries of `GET /todo/runs` carry the same `cause`. A run still `queued` or `running` 24 hours after it was queued is one a runtime left behind when it stopped; the next loop to start ends it `failed`.
- `POST /poke/{job_id}` queues one run of a job that has a `poke` trigger, with cause `poke`, and answers `202` with its `run_id`. The body is optional, under `/poke`'s limits; the run gets it as quoted, untrusted data in a block of its own (`[[ Job Poke Data ]]`, which names the job and its poke trigger; the runtime's own `/poke` keeps `[[ Wake Signal ]]`), never as part of the job's instructions. `404` for an unknown job; `409` when the job has no poke trigger, is switched off, or is already queued or running.
- When a run ends `done`, every job that uses it with mode `each` is queued, with cause `job`, `from_job_id` and the chain's `origin_run_id`. With `join: all`, a job with several `each` inputs is queued once, when every one of them has a `done` run under the same `origin_run_id`; with `any`, each input that ends queues it. When an input ends `failed` or `canceled`, a `skipped` run is recorded for each job that uses it (the note names the input), and for the jobs down the chain from those. A switched-off job is never queued by a chain, and a chain goes at most 5 jobs deep, the first run counted; in both cases a `skipped` run says why. A job that is already queued or running when a chain reaches it is not queued again (a `skipped` run says so).
- A `message` trigger fires when a message arrives in the chat it names (`internal/jobtriggers`): one run of the job is queued with cause `message` and the trigger's `trigger_id`. The run is the job's own, in the job's topic; it is given the message as JSON (`channel`, `chat_id`, `message_id`, `sender` with `id`, `name` and `is_bot`, `sent_at`, `text`, at most 4000 characters of it) quoted in a block of its own (`[[ Job Message Data ]]`), as source data and never as instructions. The channel runtime hands each inbound message to the dispatcher before it decides whether the agent answers: the conversation is handled as it would be without the job, and a message the agent ignores (a group message not addressed to it, a chat outside its allowlist, another bot's message) starts the job all the same. `chat_id` is matched without regard to case against the IDs that name the chat: `tg:<chat id>` and, for a forum topic, also `tg:<chat id>_<thread id>` (channel `telegram`); `slack:<team id>:<channel id>` (channel `slack`); `mm:<instance id>` or the instance ID alone (channel `agentlink`). Rules: only an enabled job is started; one job is started at most once per message; a job already queued or running gets a `skipped` run with the note `not started: the job was already queued or running`; a trigger starts (or tries to start) at most one run per 60 seconds, and a message that arrives sooner is dropped for it with only a debug log line (no history row: a busy chat would push real runs out of the 200 kept per job); a message already handled (an edit, or Slack's second event for a mention, under the same message ID) is dropped; the agent's own messages never start a job (the runtimes drop them before the dispatcher: Telegram by bot ID or username, Slack by bot ID or bot user ID), which covers a job's own notification to the chat; an Agent Link message that answers one this agent sent (`reply_to` set, a job's own `agent_send` included) starts none. The limit and the handled-message memory are kept in memory, per process.
- Message triggers fire on Telegram, Slack and Agent Link, wherever the runtime has a cron loop to queue the run in: the standalone `telegram` and `slack` commands with `cron.enabled` (their Agent Link runner, which they start when they serve the runtime API, uses the same loop), and the Console, for its own Agent Link runner and for the Telegram and Slack runtimes it manages (through the Console's loop). They do not fire on Discord, Lark, LINE, Mixin, WeChat, WhatsApp, Bluesky, X or the Console's own chat: a trigger for those channels is stored and never fires.
- `GET /todo/tasks`, and the answer of `PUT /todo/tasks`, may carry `warnings` on a job: a list of short plain-text strings, worked out as the list is read, never stored, and ignored when a client sends it back. Two exist: a job with `join: all` whose `each` inputs share no common upstream job (no single run leads to all of them, so the job never starts; a run of a job leads to the jobs that use it with `each`, to the jobs it needs `fresh`, and on from those), and a one-time schedule that used all its tries.
- Heartbeat does not read `TODO.md` or expand `TODO.RECUR.md`.
- `/poke` (without a job ID) is a separate awareness behavior. Its body is required and becomes the task text; empty or non-text bodies return `400 Bad Request`; bodies over 10 KB return `413 Request Entity Too Large`.
- If `/poke` arrives while an awareness task is already running, the admin server returns `409 Conflict` and the caller must retry.
- Scheduler-side skip reasons include `already_running`, `worker_busy`, `worker_queue_full`, and `empty_task`.
- Consecutive failures are tracked by `awarenessutil.State`; alert escalation is emitted after threshold.
- Code:
  - shared helpers: `internal/awarenessutil/heartbeat.go`, `internal/awarenessutil/scheduler.go`
  - runtime integrations: `cmd/mistermorph/consolecmd/local_runtime.go`, `internal/channelruntime/awareness/run.go`, `cmd/mistermorph/telegramcmd/command.go`, `cmd/mistermorph/slackcmd/command.go`
  - admin server surface: `internal/daemonruntime/server.go`, `internal/daemonruntime/poke.go`

### 5.3 Task View and Persistence

```text
runtime submit / inbound accept
  -> runtime-owned queue/worker
     - channels/console: ConversationRunner + local state
  -> taskdomain.TaskView update
     - queued / running / pending / done / failed / canceled
  -> journal append
     - ConsoleFileStore: task/topic events in journal stable segments
     - FileTaskStore: task events in journal stable segments
  -> admin/console APIs read from TaskView
```

Notes:

- Execution queues stay in the runtime layer; `taskdomain.TaskView` is read/write state for task metadata, not worker orchestration.
- `internal/taskdomain` owns task state, trigger types, the error-aware store port, and the task journal codec. Integration and daemon-backed stores use the same event schema.
- Runtime task stores append accepted task facts to the unified journal. `tasks.persistence_targets` only controls replay and projection snapshots.
- `TaskInfo.conversation` carries the source conversation id/type and the sender plus explicitly mentioned participants. Channel remains in the task target and journal trace.
- Topic list/delete APIs require `TopicReader` / `TopicDeleter`; currently Console Local provides them.

### 5.4 Plan Creation and Progress Lifecycle

```text
runtime setup
  -> RegisterPlanTool(...) (if enabled)
  -> AppendPlanCreateGuidanceBlock(...)
  -> run loop
     -> plan_create -> normalize -> validate -> cap
     -> each successful non-plan_create tool call: advance plan status
     -> final: mark remaining steps completed
```

- `plan_create` registration happens during runtime assembly when the runtime enables plan tooling (`PlanTool` feature) and calls `RegisterPlanTool(...)`.
- `RegisterPlanTool(...)` is effective only when registry is non-nil and `tools.plan_create.enabled=true` (default false; a task that names `$plan_create` still gets it).
- `tools.plan_create.max_steps` controls default plan step cap (fallback default is 6).
- Prompt guidance is injected only if `plan_create` exists in registry.
- Primary creation path is `plan_create`; direct `type="plan"` remains compatibility path.

- `agent.NormalizePlanSteps`:
  - trims step text,
  - drops empty steps,
  - normalizes status to `pending|in_progress|completed`,
  - enforces at most one `in_progress` (promotes first pending when needed).
- `plan_create.Execute(...)` calls `NormalizePlanSteps(...)` once, then:
  - rejects empty normalized steps (`invalid plan_create response: empty steps`),
  - applies `max_steps` cap.
- The tool no longer auto-fills placeholder names for empty steps.
- `AdvancePlanOnSuccess(...)` only changes status (`in_progress -> completed`, next `pending -> in_progress`) and returns `ok=false` when no valid in-progress step exists.
- `CompleteAllPlanSteps(...)` is status-only completion.

Telegram progress updates:

- Telegram runtime installs `WithPlanStepUpdate(...)` during task-run engine construction.
- On each completed plan step, it renders a short progress message via `generateTelegramPlanProgressMessage(...)` and publishes outbound with correlation id `telegram:plan:<chat_id>:<message_id>`.
- Progress send is skipped when plan is missing/empty or `CompletedIndex < 0`.

## 6. State Directory and Naming Baseline

```text
file_state_dir (default ~/.morph; --state-dir or MISTER_MORPH_FILE_STATE_DIR)
├── agent.db              config, identity and soul, heartbeat workflows, the jobs (the TODO
│                         list) the scheduler, Console and tools share, contacts and their
│                         handles, bus inbox/outbox, Console sessions, Agent Link peers,
│                         topic context use, request snapshots and workspaces
├── usage.db              LLM usage, one row per call
├── memory.db             memories
├── journal/journal.db    task and topic events
├── persona/avatar.webp
├── contacts/avatars/
├── topics/<key>/         a conversation's context checkpoint and found tools
├── locks/cron.scheduler.lck
├── guard/
│   ├── audit/guard_audit.jsonl
│   └── approvals/guard_approvals.json
└── skills/<skill>/SKILL.md
```

Additional notes:

- `internal/agentdb` opens `agent.db` (one list of migrations for every table); each store registers the one-time import of the files it replaced, which are renamed `*.imported`. See `docs/feat/feat_20261108_agent_db.md`.
- `internal/cron` keeps the job list in `agent.db`'s `jobs` table. The first time it opens an `agent.db` it imports the earlier lists once, in one transaction marked `imported:jobs` in `meta` (run with `agentdb.RunImport`, apart from the registered imports, so a failure stops only the job list): a `jobs.db` an earlier build kept the list in first, then the `cron_tasks` rows that `jobs.db` cannot already have (when there is no `jobs.db`, all of them), then `cron.yaml` when no database had taken the list over. Rows that cannot be reconciled with `jobs.db` are rejected into `import_rejects:jobs` (rules in `internal/cron/jobs_import.go`). None of the sources is changed or read again afterwards; `agent.db` keeps its now unused `cron_tasks` table. A `cron.yaml` that cannot be imported whole imports nothing and fails every open of the job list with an error naming the rejected records, until it is fixed.
- `read_file`, `send_file`, `bash` and `powershell` always deny `agent.db`, `jobs.db` and `config.yaml.imported`, and the SQLite `-wal`, `-shm` and `-journal` files of those and of every configured `deny_paths` entry (`builtin.EffectiveDenyPaths`), so a deny list written by an older config template still protects them.
- New job IDs are `job-<uuid v4>` (`cron.NewJobID`, and `lib/core/job-id.js` in the Console). A job's topic is `_cron_<job id>` and names the job in its `job_id`; each run has its own task ID and scheduler run ID.
- The heartbeat's task comes from the enabled `heartbeat_workflows` rows.
- Contacts bus dedupe keys:
  - inbox: `(channel, platform_message_id)`
  - outbox: `(channel, idempotency_key)`

## 7. Code Navigation

Recommended reading order:

1. `cmd/mistermorph/root.go` (entrypoint assembly)
2. `integration/runtime.go` (embedding entrypoint)
3. `agent/engine.go` + `agent/engine_loop.go` (execution core)
4. `internal/channelruntime/core/*` (shared channels core: runner and lifecycle)
5. `internal/channelruntime/{telegram,slack,line,lark}/runtime*.go` and `cmd/mistermorph/consolecmd/local_runtime.go` (runtime flows)
6. `internal/bus/*` and `internal/bus/adapters/*` (message bus and adapters)
