---
branch: factory/FT10-console-topic-running-indicator
round: 1
---
# Console Chat: running-task indicator on topic items

## lyric · 2026-11-05 00:06

the task runing status indicator at the right part of the topic item.

### Acceptance criteria
- In the chat view's topic list, a topic with a task running shows a status indicator at the right of its item.
- The indicator appears when a task in the topic starts and goes away when it finishes, fails or is canceled, without a reload.
- Topics without a running task show no indicator.
- It works at phone width.

## lyric · 2026-11-05 00:35
implement those two. after that, move them to review status

## factory · plan · 2026-11-05 00:35
**Behaviour**
1. The runtime serves `GET /topics/activity`: the topics with queued, running or pending tasks, with counts. Status is `pending` when a task waits for the person (an approval or a question), else `running`. It covers every topic, including Awareness and the Agent Link agents' topics.
2. The chat view polls it every 5 seconds while the page is visible, at once when the page becomes visible again, when it starts following a task, and when one it follows finishes.
3. A topic with an unfinished task shows a dot at the right of its item: pulsing orange while running, steady blue while pending. It has a tooltip and an accessible label. No motion with reduced motion.
4. Switching endpoints clears the dots. A runtime without the route shows none.

**Scope**
- `internal/daemonruntime/server_routes_tasks.go`, `TaskListOptions.AllTopics` (store and taskdomain), the chat view's topic list, CSS and strings (en, zh, ja), and `docs/console.md`.
- Left out: a push channel for task status. The Console has none per topic across runtimes, so it polls.

**Decisions**
- Polling, not push: the Console talks to several runtimes, and the only socket it has carries notifications.
- Pending shown apart from running, since it needs the person.

**Checking**
- Go: the route with mixed statuses, auth, method and empty list; the runtime's own topics counted, while a plain list still leaves them out.
- Console: normalization and signature; source checks of the polling, the dot's position and the styles.
- By hand: the dot appearing and clearing, at desktop and phone width.

## factory · 2026-11-05 00:35
Built outside the scheduled run, in the owner's checkout at the owner's request: e373403a, then 78c6d18a (counting tasks in Awareness and Agent Link topics, which a task list without a topic leaves out), from master 2bce552e.

Installs: none.

Tests: gofmt, `go vet ./...` and `go test ./...` pass; `pnpm test` 382/382 and `pnpm build` pass.

Not checked: the UI was not looked at in a browser, at desktop or phone width.

Merging with FT11: the two branches conflict in `internal/daemonruntime/console_store.go` (the same `List` filter line: keep FT10's `!opts.AllTopics &&` and FT11's `|| IsCronTopicID(item.TopicID)`) and in `web/console/src/views/ChatView.js`. Merge FT10 first.

## factory · review · 2026-11-05 00:47
head: 78c6d18a11524bb41a68ea9f7e36b96fc750289a
verdict: pass
notes:
- [P2] web/console/src/views/ChatView.js:2936: overlapping polls discard every response when requests consistently take longer than the five-second polling interval. Reproduction with six-second responses discarded all ten successful responses, leaving the indicator absent. Avoid overlapping requests for the same endpoint while preserving endpoint-switch protection.
- [P2] internal/daemonruntime/server_routes_tasks.go:538: activity aggregation reads only the first 201 tasks per status. With 202 pending tasks in distinct topics in ConsoleFileStore, HTTP 200 contained only 201 topics and omitted the oldest still-pending task. Paginate through all matching tasks before aggregating.

Reviewed by Codex against origin/master (2bce552e), all 10 changed files. No P0/P1 findings; moved to ready under the factory threshold, with the two P2 defects retained for owner review. No merge conflict with master. No source edits or commits.

Validation: configured gofmt/vet/Go test command passed in a full HEAD source copy (3597 files checked identical); pnpm test passed 382/382 and pnpm build passed with a large-chunk warning. Initial validation attempts failed because review caches were included and an incomplete copy omitted packages/workflow fixtures; complete-copy validation passed, so these are harness failures, not branch defects. Both P2 cases were reproduced.

Installs: none beyond restoring pinned console dependencies with pnpm install --frozen-lockfile.

Not checked: Chrome could not start; desktop/phone visual behavior and real task flows were not browser-verified. Reproduction artifacts retained in the review run directory. No linked GitHub issue or PR.

## lyric · 2026-11-05 10:13
check all items in ready, if they are fine, merge to master, new tag, push

## factory · 2026-11-05 10:13
Checked and found fine to ship: the review passed at the branch head (78c6d18a), with no P0 or P1.

Merged into master as 734939d5, cleanly. Gate on the merged master (FT10 and FT11 together): gofmt, `go vet ./...` and `go test ./...` pass, with a throwaway HOME; `pnpm test` 387/387 and `pnpm build` pass. Pushed to master and tagged v0.3.77 (at 353bdd87, with FT11).

Looked at in a browser, on the merged build with a throwaway home and a stand-in LLM: a topic's dot appears while its task runs and goes when the task is stopped, without a reload; it shows on TODO topics too; at phone width (about 400px) the dot sits at the right of the item. No console errors.

Shipped with the review's two P2 notes open: polls that take longer than 5 seconds drop every response, so the dot never shows on a slow runtime; and activity counts only the first 201 tasks of each status. The steady blue dot of a pending task was not seen. No linked GitHub issues or PRs to close.
