---
branch: factory/FT6-console-worker-roster
round: 1
---
# Console: worker roster for subagents and coders

## lyric · 2026-11-03 22:27

Add a place in the chat view that shows the subagents and coders working on the current task, for example a row below `.chat-status-card`. Each worker is shown as an avatar and its name (the names from the subagent names item). Clicking a worker opens its output.

### Acceptance criteria
- While a task runs, each subagent and coder it started appears with an avatar and name; finished workers stay visible with their state (running, done, failed).
- Avatars are generated per name, so a worker looks the same everywhere it appears.
- Clicking a worker shows its output (plain text, as coder output in progress) and, when it ran a process, its PID.
- The roster is hidden when a task has no subagents or coders, and works at phone width.
- It stays available for finished tasks after a reload.

## factory · plan · 2026-11-04 21:31
**Behaviour**
1. While a task runs, each `spawn` or `coder` call that carries worker metadata (FT5) adds a worker to a roster row below the status card: a generated avatar, the name, a state dot.
2. A spawn and the subtask it runs are one worker. Tool calls a worker makes add no workers; their PIDs merge into it.
3. States: running (queued, pending and running), done, failed, canceled. A worker still marked running in a task that ended shows the task's ending.
4. Clicking a worker opens a panel with its kind, state, PIDs and output as plain text (error first, else output, else summary); clicking it again closes it. "No output yet." when there is none.
5. No workers: no roster. Tasks saved before this change have no roster.
6. After a reload, finished tasks show the same roster from the saved activity.

**Scope**
- Runtime: a `workers` list in the console activity progress, kept beside `history` and saved with it.
- Console: a roster component under the status card, a pure module for the roster data and the avatars, and en/zh/ja strings.
- Left out: avatars in the progress panel's own entries (they keep FT5's name and PID label), and live process checks (FT5 PIDs are historical).

**Decisions**
- The roster is kept on the server, because the history keeps only 24 entries and early workers would drop out of a roster built from it. It holds the 32 most recent workers and counts the rest ("N earlier").
- A completion that arrives without worker metadata is matched to its worker by activity ID.
- Avatars: a hue and a mirrored 5×5 pattern from an FNV hash of the name, coloured through the theme's tokens.
- Branch base: FT6 needs FT5 (names, PIDs) and FT4 (plain-text coder output), both in `ready/` and not on master. The branch starts at origin/master 7c28c32e and merges both branches. Ship FT4 and FT5 before FT6, or with it.

**Checking**
- Go: roster across updates, history trimming, the cap, completions without metadata, save and reload.
- Console: normalization (raw and already normalized), state mapping, output priority, avatar stability, and SSR render of the roster and the detail panel.
- By hand: the roster at desktop and phone width with a real spawn and coder task.

## factory · 2026-11-04 21:31
Built outside the scheduled run, in the owner's checkout at the owner's request. Branch head a83b790f.

Built:
- `74794929`, `4e0e6bef`: merges of FT5 and FT4. The only conflict was the imports in `ChatStatusCard.js`: kept FT5's `activityWorkerLabel` and dropped `MarkdownContent`, which FT4 removed. `e73868f6` gives FT4's status card test the `activityWorkerLabel` FT5 added.
- `a83b790f`: the roster. `cmd/mistermorph/consolecmd/activity_progress.go` adds `workers`, `workers_omitted` and `syncConsoleActivityWorkers`. `web/console/src/core/chat-workers.js` and `components/ChatWorkerRoster.{js,css}` add the Console side, rendered from `ChatHistoryItem.js`. The design is in `docs/feat/feat_20261104_console_worker_roster.md`.

Installs: none.

Tests: gofmt, `go vet ./...` and `go test ./...` pass. `pnpm test` 374/374 and `pnpm build` pass. New tests: `activity_progress_roster_test.go`, `chat-workers.test.mjs`, `chat-worker-roster.test.mjs`.

Not checked: the UI was not looked at in a browser, at desktop or phone width.
