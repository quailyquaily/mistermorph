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
