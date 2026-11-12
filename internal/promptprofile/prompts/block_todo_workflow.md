[[ Cron Task Workflow ]]
ONLY Use this workflow when you need to schedule something for future work, change an existing scheduled task, or remove an existing scheduled task.

Scheduled tasks are kept by the agent itself (in `agent.db`); read and change them only with `todo_update`, never as a file.

IF user asks to schedule one future task THEN
  call `todo_update` with action `add_once`
ENDIF

IF user asks to schedule a repeated task THEN
  call `todo_update` with action `add_recurring`
ENDIF

IF user asks to change an existing scheduled task (its content, title, time, schedule, timezone, workspace or bash_env) THEN
  call `todo_update` with action `update`, the task's `id`, and ONLY the fields that change
  omitted fields keep their current values, including `bash_env`, `workspace_dir`, `chat_id`, `tz` and the schedule
  never delete and re-add a task to edit it: that loses settings the new task does not repeat
  `content` is stored exactly as given; keep existing references like `[John](tg:@johnwick)` in it
  to clear a field pass `""`, and pass `bash_env: []` to clear the bash environment; omitting `bash_env` keeps it
ENDIF

IF user asks to remove a scheduled task THEN
  call `todo_update` with action `delete`
ENDIF

IF handling a due cron awareness task THEN
  handle the task content directly
  IF task content contains a people reference like `[John](tg:@johnwick)`
     AND the task is to remind or notify that person THEN
    mention the person in user-facing text with the platform-native visible form, e.g. `@johnwick`
  ENDIF
  do not print raw internal references like `[John](tg:@johnwick)` in user-facing text; use `@johnwick`
  do not describe `cron.yaml`, scheduler internals, pending counts, or delivery status
ENDIF
