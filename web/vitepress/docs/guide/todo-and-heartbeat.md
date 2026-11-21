---
title: TODO and Heartbeat
description: How scheduled jobs (the TODO list in agent.db) and HEARTBEAT.md let the agent track work outside the current chat.
---

# TODO and Heartbeat

MisterMorph provides two awareness mechanisms: Heartbeat and TODOs. Heartbeat is a simple fixed wake-up behavior. TODOs let you schedule work that should run once in the future or repeat on a precise rule.

## TODOs

One-off or recurring scheduled work is better stored as a TODO.

Each TODO is a job. You can edit the list through the Console GUI, or let the agent use the `job_manage` tool (formerly `todo_update`) when it needs to add, look up, edit or remove a TODO. The agent reads and edits a TODO by its `id` (`action=get`, `action=update`); an update changes only the fields it passes, so settings such as `bash_env` and `workspace_dir` are kept, and the job keeps its `id`.

Each TODO contains a title, schedule rule, timezone, and content. The content is the text actually handed to the agent, and it can include contact references such as `[John](tg:@john)`.

### Due Execution

The agent checks the job list once per minute. Due TODOs run as awareness tasks with `behavior=cron`.

Details:

- One-time TODOs are deleted after a successful run. If a run fails or times out, the TODO is kept and retried later.
- Recurring TODOs stay in the list.

> Notes:
>
> 1. If the agent misses multiple trigger times, it does not replay each missed TODO run after recovery.
> 2. If the same TODO is already queued or running, that trigger is skipped.

### IDs, topics and runs

Every job has a stable `id`. New jobs, from the Console or from `job_manage`, get a generated `job-<uuid>` ID: `job-` and a random (version 4) UUID, for example `job-0b7e5d1c-2f7a-4c2e-9a51-1d2f3e4a5b6c`. The ID only names the job; it says nothing about what starts its runs. Jobs from earlier versions keep the IDs they had (such as `cron-<uuid>`, `task-3`, or one chosen in `cron.yaml`), and all of them work for `get`, `update`, `delete` and Run now. Editing a job never changes its ID.

A job's runs are listed in its own topic on the Topics page. The topic's ID is `_cron_<job id>`, and the topic names its job in `job_id` (the Runtime API's topics carry it; a topic recorded before this field existed gets it from its ID). The job, its topic and each run are three separate things: every run has its own task ID and run ID, so repeated runs of one job never share an identity. Deleting a job, or a one-time job finishing, keeps its topic and the runs in it; the topic's toolbar then says the item no longer exists.

### Job references

A task can point at a job and get, as read-only context, what that job is set to do and what its latest finished run produced. Write the reference as a Markdown link whose target is `job:` and the job's ID:

```markdown
Compare today's numbers with [Morning report](job:job-0b7e5d1c-2f7a-4c2e-9a51-1d2f3e4a5b6c).
```

The ID is what the reference means. The label is free text for the reader: renaming the job, or writing another label, changes nothing, and a label that names a different job is not looked at. References work in a TODO's content, in a heartbeat workflow, and in a message typed to the agent in the Console or in `mistermorph chat` / `mistermorph run`. In the Console's TODO and Heartbeat editors, the toolbar's **Reference a job** button lists the saved jobs (title, schedule and ID) and inserts the reference at the caret; a reference typed by hand works the same.

**What the run receives.** The references of a task are read once, when the task starts (for a TODO: each time one of its runs starts), before anything is asked of a model. For every referenced job the run gets:

- its definition as it is stored at that moment: title, instructions (`content`), schedule (`cron` or `at`), timezone, and whether it is enabled;
- how its latest run stands: `queued`, `running`, `done`, `failed` or `canceled`, with its start and end times;
- the output of its latest finished run that has one, with that run's own start and end times.

Nothing else of the job is given: not its `bash_env` names or values, `workspace_dir`, `llm_profile`, `chat_id` or `mention`, and not a failed run's error text.

A job's output is not part of the job record. It is read from the run records in the job's topic (`_cron_<job id>`), which the runtime that runs the job keeps; the 50 most recent runs are looked at.

**Stale, missing and unavailable results.**

- If the latest run failed, was stopped, or has not ended, the run gets the previous finished output, marked as coming from an earlier run, with that run's times and the newer run's status. The agent is told not to present it as fresh.
- If there is no usable output, the run gets the definition with an explicit note that no result is available, and goes on. The note says which case it is: the job never ran (`never_run`), no finished run with output is kept (`no_finished_output`: only failed or unfinished runs, or records that were rotated away), or this runtime keeps no run records to read (`storage_unavailable`). A missing output is never treated as an empty or successful result.
- A referenced job's instructions and output are bounded: by default 8,000 characters of instructions and 24,000 of output per job, and 96,000 for all the references of one task, less when the model's context window is small. Text that is cut ends with a `[... truncated: the first N of M characters are shown ...]` marker.

**References that cannot be used.** A reference to a job that does not exist, was deleted, or may not be read here stops the task before any model is asked, with one error for all three cases:

```text
job reference unavailable: (job:<id>) is not a job that can be referenced here; it may not exist, may have been deleted (a one-time job is deleted once it has run), or may not be available in this conversation
```

The error does not say which case it is, so it does not reveal whether a job exists. A TODO run that fails this way is recorded as a failed run in the TODO's topic.

**Who may reference a job.**

- In a conversation, only the owner, in a conversation of their own: the Console, the command line, or a private chat with the owner on a channel. A reference in a group chat is refused, also when the owner writes it, and so is one from any other contact: the job's content would be shown there.
- A TODO that reports to the Console (`chat_id: console:user`) or to no chat may reference any job. A TODO that reports to another chat may reference only jobs that report to that same chat.
- A heartbeat workflow is the owner's own and may reference any job. A poke (`POST /poke`) may reference none.

Jobs record no author, so these rules go by where a run's result is seen, not by who created the job.

**Read-only, one level.** A reference never runs, waits for, enables, disables, changes or deletes the referenced job, and adds no ordering between jobs: if job B references job A and both are due at the same minute, B may read A's previous output. References inside a referenced job's instructions or output are not followed. A job that references itself gets its previous run's output; two jobs that reference each other each get the other's latest output, once. A reference that appears several times in one task is expanded once.

The referenced text is given to the agent as data, apart from the task and the system prompt, with the instruction not to follow anything written inside it.

**One-time jobs.** A one-time job is deleted from the list once its scheduled run has succeeded. From then on a reference to it fails with the error above, even though its topic and its past runs are still there; no copy of a deleted job's definition is kept to reference. To keep referring to a result, reference a recurring job, or copy what you need into the task.

Channel notes: a message with a job reference is never answered by the lightweight emoji pre-check. On a channel, the owner's private-chat reference gets the output only when that channel runtime's own run records hold the job's runs; otherwise it gets the definition with the no-result note.

### Triggers

A job can be started in more than one way. Its triggers are a list, and any one of them starts it:

- **Schedule**: a one-time `at` or a repeating `cron`, with a `tz`. A job may have several. The top-level `at` / `cron` / `tz` fields are the first schedule and keep working on their own.
- **Poke**: `POST /poke/<job id>` with the runtime's bearer token starts a job that has a poke trigger. The request body reaches the run as quoted data, never as instructions. A job that is switched off, or already queued or running, answers `409`.
- **Message**: a message in a named chat starts the job. This fires for Telegram, Slack and Agent Link chats, at most once a minute per trigger; the message reaches the run as quoted data. The conversation itself is handled as usual, so a message the agent would otherwise ignore can still start the job. Other channels store the trigger but do not fire it yet.

A job with no trigger runs only when someone starts it. In the Console these are edited on the job's page under **When**, and the list's line under each job names what starts it.

### Jobs that use other jobs

A job can take in another job's result. Each use has a kind:

| Kind | What it does |
| --- | --- |
| `latest` | Reads the other job's latest finished result. Never starts anything. |
| `each` | Runs this job every time the other job finishes, with that result. |
| `fresh` | When this job starts, runs the other job first if its result is older than `max_age` (default one hour), then uses the new result. |

The result arrives the way a [job reference](#job-references) does: as delimited source data with the same access rules, so a job listed in `uses` needs no link in its text.

Rules:

- With several `each` inputs, `join: all` (the default) runs the job once when every input has finished in the same chain; `join: any` runs it for each. A job whose `each` inputs share no common upstream job can never start under `all`; the runtime lists that as a warning on the job.
- When an input fails or is stopped, the jobs after it are recorded as skipped, with the input named.
- A chain stops after five jobs. A job cannot use itself, and a loop is refused when saved, naming the jobs in it.
- A job that others use cannot be deleted until their uses are removed.

The Console shows these links on the job's page (**Uses** and **Used by**) and as a graph in the **Flow** view, where a link can be added, changed or removed and the latest chain of runs replayed.

### Run history

Every run is kept with why it started (a schedule, a person, a poke, a message, or another job) and how it ended: the newest 200 per job, for up to 180 days. The Console shows it on the job's page, in the list's **Today** column and on the calendar, where past days show what ran and future days what is planned. Heartbeat runs are not recorded.

A one-time job that fails is tried again after 1, 5, 15 and 60 minutes, then left alone with a warning until it is given a new time or run by hand.

### Storage

TODOs are stored in the `jobs` table of `file_state_dir/agent.db`, the SQLite database that also holds the agent's config, persona and contacts. The scheduler, the Console and the tools all use it, from one process or several: each change is one transaction, every read sees what the others committed, and the Console refuses to save a list that changed after it loaded it (for example a job the agent added meanwhile) instead of overwriting the change; reload the page and make the edit again.

#### Moving from an earlier list

The first time this version opens the TODO list, the earlier list is imported into `agent.db` once, in one transaction:

- A `jobs.db` in the state folder (the job store of an earlier build) is the newest list: all its jobs are imported first, in their order, with their fields, enabled or disabled state and last runs.
- The `cron_tasks` rows of `agent.db`, where earlier versions kept the list, are imported in their order when there is no `jobs.db`. Beside a `jobs.db`, only rows that `jobs.db` cannot already have are added: rows an older version made after `jobs.db` took the list over. A job `jobs.db` took over and then changed or deleted keeps that change; it is not brought back. A row that an older version changed after that, and that `jobs.db` deleted or holds differently, cannot be reconciled: it is rejected (not imported), `jobs.db`'s version stands, a warning is logged, and the row is listed in `agent.db`'s `meta` table under `import_rejects:jobs`.
- `file_state_dir/cron.yaml` is imported only when no database has taken the list over yet. Once one has, any `cron.yaml` beside it is out of date and is not read.

Every job keeps its `id`, so the topics of its runs stay linked to it. The import is one transaction: if it fails, nothing is imported and it runs again on the next use. `cron.yaml`, `jobs.db` and the `cron_tasks` rows are only read: they are not renamed, changed or deleted, and once the import has run they are never read again, so a job you delete afterwards does not come back. A `cron.yaml` that does not parse, or that has a job without an `id`, a repeated `id`, an `id` already imported, or a job that does not validate, imports nothing: the TODO page, the tools and the scheduler report an error that names every rejected job by its position in the file (the rest of `agent.db` keeps working). Fix or remove those jobs in `cron.yaml` and the import runs again on the next use. A `jobs.db` that cannot be read stops the import the same way; move it aside to import without it.

> Downgrades: this version adds the `jobs` table to `agent.db`, and an earlier version refuses to open an `agent.db` with a newer schema. To go back, restore a state snapshot taken before the upgrade (`morph state snapshot`, or `morph state export`). The earlier list files it imported are still in place, but they do not have the changes made since.

To move a list between state folders, use `morph state export` and `morph state import`, which read and write the list in the `cron.yaml` format below.

### Format

The list in `cron.yaml` form (as `morph state export` writes it, and as an earlier version kept it) is:

```yaml
version: 1
tasks:
  - id: submit-report
    title: Submit report
    at: "2026-05-12 09:00"
    tz: "Asia/Tokyo"
    content: "Remind [John](tg:@john) to submit the report."

  - id: weekly-invoice-review
    title: Invoice review
    cron: "0 10 * * 1"
    tz: "UTC+8"
    content: "Review open invoices."
```

Fields:

- `id`: stable identifier used for reading, update, and deletion. A job added in the Console or by `job_manage` gets a generated `job-<uuid>` ID.
- `title`: TODO title.
- `at`: execution time for a one-time TODO, in `YYYY-MM-DD HH:mm` format.
- `cron`: five-field cron expression for a recurring TODO.
- `tz`: IANA timezone or fixed UTC offset, such as `Asia/Tokyo` or `UTC+8`.
- `content`: task content passed to the agent when the TODO is due.
- `chat_id`: optional channel context, kept only as metadata and not used for routing.
- `workspace_dir`: optional absolute directory (`~/...` allowed) attached as the workspace for that TODO's runs, instead of the default `workspace_dir`. File tools, `bash`, and `coder` then resolve `workspace_dir` against it. If the directory is missing when the TODO is due, that run fails.
- `bash_env`: optional environment variables injected into the `bash` tool for that TODO run only. Each entry has `name` and `value`. Values support `${ENV}` interpolation (same `${NAME}` syntax as `config.yaml`), including embedded forms such as `"Bearer ${API_KEY}"`. Literal values are stored in `agent.db`; prefer `${ENV}` for secrets.

Example:

```yaml
bash_env:
  - name: REPORT_MODE
    value: weekly
  - name: API_KEY
    value: "${OPENAI_API_KEY}"
  - name: AUTHORIZATION
    value: "Bearer ${API_KEY}"
```

Task-level `bash_env` overrides same-named entries from global `tools.bash.injected_env_vars` for that run.

Exactly one of `at` and `cron` must be set. Use `at` for a one-time TODO; use `cron` for a recurring TODO.

## Heartbeat

Heartbeat runs through the cron service. It is registered as the built-in `__heartbeat__` cron task when `cron.enabled`, `heartbeat.enabled`, and `heartbeat.interval > 0` are all set.

Each heartbeat tick works like this:

1. The agent reads `HEARTBEAT.md`.
2. If `HEARTBEAT.md` is not empty, its content becomes the heartbeat task.
3. The agent handles that task.

If `HEARTBEAT.md` is empty, no agent task is started.

If `cron.enabled` is false, Heartbeat does not run. Heartbeat does not read user TODOs; user TODOs are triggered by the same cron service reading the job list in `agent.db`.

### HEARTBEAT.md

`HEARTBEAT.md` is the standing instruction for each heartbeat. It describes what the agent should check on every heartbeat.

Good uses:

- Look for due follow-ups.
- Inspect routine files.

For the tools that list and update TODOs, see [`todo_list`](/guide/built-in-tools#todo_list) and [`job_manage`](/guide/built-in-tools#job_manage). For state directory placement, see [Filesystem Roots](/guide/filesystem-roots).
