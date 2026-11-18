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

A job's runs are listed in its own topic on the Topics page. The topic's ID is `_cron_<job id>`, and the topic names its job in `job_id` (the Runtime API's topics carry it; a topic recorded before this field existed gets it from its ID). The job, its topic and each run are three separate things: every run has its own task ID and run ID, so repeated runs of one job never share an identity. Deleting a job, or a one-time job finishing, keeps its topic and the runs in it; the topic then says the item is no longer in TODO.

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
