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
