---
branch: factory/FT20-console-todo-topic-navigation
round: 1
---
# TODO task topic entry and manual-run confirmation

## factory · 2026-11-06 16:35
Requested by the owner through Console:

> factory new feature:
> add an entry at todo view, to the cron topic view (if have).
> if user click run manually, provide a dialog, tell user the task will start soon, give a button in the dialog to guide user to the topic view of this task. if user visit the topic view of the task, the column 2 of topics page should switch the toggle of the cron button "TODO runs"

Requirements and acceptance criteria:
- In the TODO view, expose an entry to the task's existing cron/TODO-run topic when one exists. Resolve the actual task-to-topic relationship; do not route to an unrelated topic or create a topic merely by viewing a TODO.
- After a manual Run request is accepted, show a dialog explaining that the task will start soon, with a clear action to open that task's topic and an ordinary dismiss action. Do not claim execution has started or completed merely because the request was accepted.
- Handle the first run, when the topic may not yet exist: show a restrained preparing/loading state, resolve the topic once available, and enable navigation without a page refresh. Do not offer a broken link. Handle failures or a topic that remains unavailable with useful feedback and a safe dismiss/retry path that does not submit another run accidentally.
- If the Run request fails, show the actual error rather than the success/queued dialog. Avoid duplicate submissions while the request is pending; dismissing the dialog does not cancel the accepted run.
- Both the TODO-view entry and the dialog action open the correct task topic on the Topics/Chat page. Column 2 must switch the "TODO runs" cron toggle ON (not invert its current state), load the cron-topic list, and select/show the target topic. Navigation must work whether the filter was previously off or on, and must not lose the target during asynchronous list loading.
- Follow existing Console dialog, button, icon, spacing, theme, localization, and accessibility patterns. Keep the dialog concise, keyboard accessible, and usable on mobile; do not invent a competing navigation/filter design.
- Preserve normal topic navigation, scheduling behavior, and existing cron running indicators. This feature is navigation and run-request feedback, not a scheduler change.
- Add regression coverage for existing/no-topic TODO entries, manual-run success/failure, delayed first-topic creation, repeated clicks, dialog dismissal, and navigation with the TODO runs filter initially off/on.

Not implemented yet.

## factory · plan · 2026-11-06 21:28
Behaviour: Look up the selected TODO's existing task topic using GET only, never creating a topic by viewing an item. After an accepted manual run, show queued feedback and a dismiss action; enable navigation when the exact topic exists. Poll for first-topic creation; expose errors/timeouts and lookup-only retry without resubmitting. Prevent duplicate pending submissions. Navigation sets TODO runs ON and preserves the target through asynchronous loading.

Scope: Console navigation, shared dialog button states, localization and regression tests. Scheduling and runtime behavior are unchanged.

Decisions: Validate the canonical _cron_<taskID> topic through the endpoint used by ChatView. Poll once a second for up to 30 seconds. Dismissal stops UI polling, not the accepted run. Ordinary topic navigation retains its existing filter behavior.

Checking: Test existing/missing topics, accepted/failed runs, delayed creation, duplicate clicks, dismissal/retry and filter initially off/on. Run Console tests/build and the configured Go checks. Inspect browser UI when available.

## factory · 2026-11-06 21:28
Recovered the interrupted build's two existing item commits; preserved the leftover test HOME outside the worktree. Claude Code checked the implementation and required no additional edits. No merge was needed: the fetched master is already an ancestor of this branch.

Built: existing-topic entry in TODO view; queued manual-run dialog with bounded read-only lookup and safe retry/dismissal; topic navigation enabling TODO runs without losing the target. Updated all three Console languages and regression coverage.

Commits: d25b80ae, 6687afe4. Head: 6687afe4d411e3dc55b17aef02a341caf88164c6.
Installs: none.
Tests: Console tests passed (448); pnpm build passed with a chunk-size warning. Configured gofmt, go vet ./... and go test ./... passed, independently rerun by the manager. Tests used throwaway HOME directories.
Not checked: no live browser visual, mobile-layout or keyboard walkthrough; these still need manual inspection. No live LLM-backed run was exercised.
Moved new/ → review/ for review; not merged or released.
