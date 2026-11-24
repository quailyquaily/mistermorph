# Run jobs in the integration runtime

## factory · 2026-11-24 15:31
Owner request: “is the integration support jobs ?” → “add to factory new/”

Today `integration` only half supports jobs. It registers the `job_manage` tool (`integration/channel_bots.go`, `sharedDependencies`), so an embedded agent can create, list, edit and stop jobs, and they are saved to `Paths.CronPath`. But nothing in `integration` ever runs them:

- Scheduled runs: the awareness loop (`internal/channelruntime/awareness/run.go`, `Run`) runs due jobs and the heartbeat. Only the CLI starts it: `cmd/mistermorph/consolecmd/local_runtime.go`, `telegramcmd`, `slackcmd`, `discordcmd`, `accountdmcmd`.
- Message-triggered jobs: a `jobtriggers.Dispatcher` (`jobtriggers.New(cronPath, cronRun, logger)`) is handed to the channel runtimes only by those commands. The channel bots `integration` starts never get one.
- Run now / poke: `CronRun` (`daemonruntime.CronRunFunc`) is never set by `integration`, so the job poke route has nothing to call.

So jobs created through an embedded runtime pile up and only fire if a `mistermorph` process happens to run on the same state dir.

Make jobs work end to end for embedders, the same way the CLI commands do:

- When `job_manage` is enabled and selected, run the awareness loop beside the runtime, with a `CronRequests` channel, so scheduled jobs (and the heartbeat, where the CLI runs it) fire. One loop per runtime, however many channel bots it starts; stopped when the runtime / bots stop.
- Pass `CronRun` (backed by `awareness.StartCronRun` on that channel) and a `jobtriggers.Dispatcher` to every channel bot `integration` starts, so message-triggered jobs and job pokes work.
- When `job_manage` is off, start none of this.
- Reuse the CLI's wiring rather than copying it; keep CLI behaviour unchanged.
- Update `docs/integration.md` to say how jobs run in an embedded runtime and what the embedder must keep alive.

Acceptance criteria:
- With `job_manage` enabled, a scheduled job created through an embedded runtime runs on time without any `mistermorph` CLI process.
- A message that matches a job trigger, sent to a channel bot started by `integration`, starts that job.
- With `job_manage` disabled, no awareness loop or trigger dispatcher starts.
- Tests cover the enabled and disabled cases.
