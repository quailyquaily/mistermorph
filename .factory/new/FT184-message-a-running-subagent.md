# Send a message to a running subagent, from the Console and the terminal chat

## factory · 2026-11-24 23:22
Owner request: “if i'd like to send message to the subagent, is it possible?” … “if i'd like to do, what shoud we do?” … “yes. one more thing, let the console web support it as well. add this task to new/”

Today a message typed while a task runs is steered to the parent only: the engine drains its `SteerSource` at each step (`agent/engine_loop.go:873` `applyQueuedSteer`, `agent/types.go:88`), and the Console's steer path answers with `steer_target_task_id` (`cmd/mistermorph/consolecmd/local_runtime_steer.go`, `web/console-nsh/pages/chat/chatController.ts:3307`). A child started by `spawn` runs with no steer source (`agent/local_subtask_runner.go:142`, `RunOptions` without `SteerSource`), and while it runs the parent waits inside its `spawn` call, so nothing the user types reaches the child before it returns. The child views are read-only: the Console's worker roster and its detail panel (`components/chat/ChatWorkerRoster.tsx`, `pages/chat/ActivityDetailPanel.tsx`), and the terminal chat's `/agents` inspector (docs/chat.md "Inspect subagents": "Inspection is read-only").

Do all of it in this one item (the UI needs the API; a separate item would be built from `master` without it):

1. **Engine.** A spawned child gets its own steer source and takes the user's messages at its next step, as the parent does. They enter its conversation marked as from the user, not from the parent.
2. **Runtime.** Each task keeps the steer sources of its running children (registered when `spawn` starts one, removed when it returns). The steer path takes an optional target child ID. A child that has already returned: the message is not dropped; the answer says it finished, and the client offers to send it to the parent instead.
3. **Parent.** When a steered child returns, its result says the user redirected it, so the parent does not treat the changed result as a fault. The message is recorded in the child's execution record and in the parent's history, and survives reopening the topic.
4. **API and events.** The Console API's steer takes the target child; the live event stream reports a child message as queued, then applied (with the step). Document it in `docs/console.md`.
5. **Console (web, desktop and Android; one TSX app in `web/console-nsh`).** A running worker's panel (opened from its roster chip) gets a message field; sending queues the message to that worker, shows it as queued until the worker takes it, then in the worker's record where it was applied. A finished worker's panel has no field. On phones the field fits the panel's sheet. Same strings in English, Chinese and Japanese.
6. **Terminal chat.** The `/agents` inspector gets an input line for the child on screen (or `/steer <child-id> <text>`; pick one and document it in docs/chat.md).

Decisions:
- A message lands at the child's next step; it never interrupts a model call or a running tool.
- `coder` workers (external CLIs) cannot take messages mid-run: their panels have no field and say why.
- Any running child of the task can be targeted, nested ones included.
- Agent Link (`agent_send`) conversations are out of scope.

Acceptance criteria:
- Go tests: a child takes a steered message at its next step; a message to a child that has returned is answered, not lost; the parent's history and the child's record hold it; `coder` children refuse.
- Console tests: the worker panel's field sends to that worker, shows queued then applied, is absent for finished and coder workers, and fits a 360pt phone.
- `go test ./...`, `go vet ./...` and the full Console test runner pass.
