---
branch: factory/FT11-console-cron-topics
round: 1
---
# Console Chat: a topic for each TODO cron item, and a cron-only topic list

## lyric · 2026-11-05 00:06

if each todo cron item has it's own topic at the chat view, it would be great. and we can provide a toggle to switch the topic list to a list which only has cron topics.

### Acceptance criteria
- Each TODO (cron) item has its own topic in the chat view, holding that item's runs.
- A toggle switches the topic list between all topics and cron topics only.
- A cron topic is easy to tell apart from a normal topic in the list.

## lyric · 2026-11-05 00:35
implement those two. after that, move them to review status

## factory · plan · 2026-11-05 00:35
**Behaviour**
1. A TODO item's run is recorded in the topic `_cron_<task_id>`, titled after the item (or "Unititled TODO", the existing default), and renamed when the item is. The heartbeat stays in Awareness.
2. TODO topics are reserved like Agent Link topics: never titled by the LLM, untagged, and kept when deleted, so the next run has its topic.
3. The chat view's date and tag lists leave TODO topics out. An alarm-clock button, shown once a TODO topic exists, switches the list to the TODO topics only, the latest run first; pressed again, it returns to the date list. Like the agents list, this view is not remembered across visits.
4. A TODO topic shows an alarm-clock icon. The composer is replaced by a note: the item's runs appear there, and the item is changed in TODO.
5. An open TODO topic checks for new runs every 5 seconds, like Awareness.

**Scope**
- `internal/daemonruntime` (topic IDs, reservation, the store), the awareness runtime's cron recording, the chat view, the icon list, strings (en, zh, ja), and `docs/console.md`.
- Left out: moving earlier runs out of Awareness. They stay where they were recorded.

**Decisions**
- Separate from the person's topics, with a toggle, as with the agents' topics; otherwise frequent runs would push the person's topics down.
- Read-only: chatting in a TODO topic would not change the item.
- Recording a task with its topic's current title no longer bumps the topic's title revision, so repeated runs do not churn it.

**Checking**
- Go: runs recorded under the item's topic with its title; a heartbeat stays in Awareness; topic creation, renaming, no revision bump for the same title, listing, and refused deletion.
- Console: source checks of the filtering, the toggle, the icon, the title, the read-only note and the refresh; strings in all three languages.
- By hand: the toggle and a TODO topic receiving a run, at desktop and phone width.

## factory · 2026-11-05 00:35
Built outside the scheduled run, in the owner's checkout at the owner's request: e0b01f0a, from master 2bce552e.

Installs: none.

Tests: gofmt, `go vet ./...` and `go test ./...` pass; `pnpm test` 382/382 and `pnpm build` pass.

Not checked: the UI was not looked at in a browser, and no real TODO run was recorded through the Console.

Merging with FT10: see FT10. The branches conflict in `console_store.go` and `ChatView.js`; merge FT10 first.

## factory · review · 2026-11-05 00:59
head: e0b01f0abdec943411165f18c0542e4a1c12b6a0
verdict: fix
fix:
- [P1] internal/codemode/run_test.go:365: Required test command initially failed in TestMemoryWatcherStopsInvocations (`failed 0:slow:failed`). Investigate/stabilize the failure before approval. This is a factory test-gate finding, not a proven introduced defect: the exact command passed on retry; the test code is unchanged, and baseline overlay single-test/package checks each passed 20 repetitions.
notes:
- [P2] web/console/src/views/ChatView.js:855: Keep the sidebar and cron toggle accessible when only cron topics exist. Example: no normal topics plus one TODO run makes visibleTopics empty, hiding the desktop sidebar; mobile switches to chat without a return entry. Confirmed by executing the layout calculations.
- [P2] internal/daemonruntime/types.go:191: Enforce cron topic read-only status at the backend submit entry, not only the composer. Example: submitting /help to _cron_weekly succeeds, and a supplied topic_title overwrites the TODO topic title. Confirmed through a temporary Go reproduction.
- [P2] internal/channelruntime/awareness/run.go:353: Synchronize topic titles when saving a renamed TODO, not only when a run starts. Example: rename and disable a TODO with existing runs; the saved TODO has its new title while its topic retains the old title indefinitely. Confirmed through HTTP routes.
- [P2] web/console/src/views/ChatView.js:1053: Refresh updated_at and reorder cron topics even when title/revision are unchanged. Example: A runs again after B, but metadata polling discards A's changed timestamp and leaves A behind B. Confirmed by executing frontend logic.

Reviewed all 10 changed files in origin/master...HEAD, against master 2bce552ee9e2c604830ea600ef7be055f3e71df0. The branch merges cleanly with that master; no conflict resolution or code changes were needed.

Validation: required gofmt/vet/Go-test command failed once as above, then passed in full on retry. pnpm test passed 382/382; pnpm build passed with a large-chunk warning. Temporary Go and frontend reproductions confirmed the four P2 findings. git diff --check passed. Tracked worktree and HEAD unchanged.

Installs: none requiring reporting. Browser visuals and a real TODO run through Console were not checked. No linked GitHub issues or PRs were present. Item remains in review/ for the owner to decide; add a note and move it to new/ for fixes.
