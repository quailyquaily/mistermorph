[[ Job Workflow ]]
ONLY Use this workflow when you need to schedule something for future work, look up, change or remove an existing scheduled job.

Scheduled jobs (the TODO list) are kept by the agent itself (in `jobs.db`); read and change them only with the tools named here, never as a file.
Every job has a stable `id`: new jobs get a generated `job-<uuid>` id, older jobs keep the ids they had. A job's runs and its topic are separate from it and have ids of their own; never use a run or topic id as a job id.

{{TODO_LIST_BEGIN}}
IF user asks which jobs are scheduled, or whether a job is enabled or disabled, OR you need a job's `id` THEN
  call `todo_list`: it returns every job, each with its `id`, schedule and an `enabled` boolean
  `todo_list` only reads; it never changes or runs a job
ENDIF

{{TODO_LIST_END}}
IF user asks to schedule one future job THEN
  call `job_manage` with action `add_once`; do not pass an `id`: the result returns the generated one
ENDIF

IF user asks to schedule a repeated job THEN
  call `job_manage` with action `add_recurring`; do not pass an `id`: the result returns the generated one
ENDIF

IF you need the details of one job whose `id` you know THEN
  call `job_manage` with action `get` and the job's `id`
ENDIF

IF user asks to change an existing scheduled job (its content, title, time, schedule, timezone, workspace or bash_env) THEN
  call `job_manage` with action `update`, the job's `id`, and ONLY the fields that change
  the job keeps its `id`; update never makes a new job
  omitted fields keep their current values, including `bash_env`, `workspace_dir`, `chat_id`, `tz` and the schedule
  never delete and re-add a job to edit it: that loses settings the new job does not repeat, and its id
  `content` is stored exactly as given; keep existing references like `[John](tg:@johnwick)` in it
  to clear a field pass `""`, and pass `bash_env: []` to clear the bash environment; omitting `bash_env` keeps it
ENDIF

IF user asks to remove a scheduled job THEN
  call `job_manage` with action `delete` and the job's `id`
ENDIF

IF handling a due cron awareness task THEN
  handle the task content directly
  IF task content contains a people reference like `[John](tg:@johnwick)`
     AND the task is to remind or notify that person THEN
    mention the person in user-facing text with the platform-native visible form, e.g. `@johnwick`
  ENDIF
  do not print raw internal references like `[John](tg:@johnwick)` in user-facing text; use `@johnwick`
  do not describe `jobs.db`, `cron.yaml`, scheduler internals, pending counts, or delivery status
ENDIF
