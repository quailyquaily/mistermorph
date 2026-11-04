---
branch: factory/FT8-cron-parallel-jobs
round: 1
---
# Cron: run TODO items in parallel

## lyric · 2026-11-04 10:57

Scheduled TODO items run one at a time today. The cron loop (`internal/channelruntime/awareness/cron.go`) has a single worker, and each run lasts until its agent task is done. A long item (a factory build can take 40 minutes) holds up every other item that comes due, and the heartbeat with them. Let different items run at the same time.

### Acceptance criteria
- Different TODO items run in parallel, up to a limit set in config (a new key, documented in `assets/config/config.example.yaml`). Items beyond the limit wait in order, as today.
- One item never overlaps itself: an occurrence that comes due while the same item is still waiting or running is skipped, as today, and "run manually" still answers 409.
- The heartbeat is not held up by long TODO items.
- Shutdown still waits for running items to finish or stop, and drops nothing silently.
- The TODO panel shows which items are running now.
- Tests cover two items running at once, the limit, and an item that comes due while it is still running.

## factory · 2026-11-04 20:50
Built outside the scheduled run, in the owner's checkout at the owner's request, as commit 264d6591 on `factory/FT8-cron-parallel-jobs` (from master 7c28c32e).

Built:
- `internal/channelruntime/awareness/cron.go`: a pool of `cron.max_concurrency` workers takes TODO items in order; system tasks (the heartbeat) have a lane of their own. The in-flight check is unchanged, so an item that is waiting or running is skipped when it comes due again, and a manual run answers 409.
- Shutdown: running items get the cancelled context and are waited for; items still queued are logged as `cron_skip reason=shutdown`.
- `internal/cron/runs.go`: each loop registers a board of queued and running items under its cron file; `GET /todo/runs` and the `runs` field of `GET /todo/tasks` list them.
- Console TODO panel: polls `/todo/runs` every 5 s, shows "Running" (pulsing dot) or "Waiting" on rows and the heartbeat row, and disables Run while the item is in flight. en/zh/ja strings.
- Config: `cron.max_concurrency`, default 8 (owner's choice), applied on runtime restart, documented in `assets/config/config.example.yaml` and `docs/arch.md`; wired into the console, telegram, slack, discord and accountdm runtimes.

Decisions:
- The heartbeat does not count toward the limit, so long items never hold it up.
- Run state is visible to the TODO API in the same process as the cron loop, which is how every runtime serves it.

Installs: none.

Tests: gofmt, `go vet ./...` and `go test ./...` pass; the cron loop tests passed 30 runs under `-race`. `pnpm test` 355/355 and `pnpm build` pass. New tests cover two items at once, the limit and order, an item due while running or queued, the heartbeat with every slot taken, shutdown, the run board, and the routes.

Not checked: the TODO panel UI was not looked at in a browser.
