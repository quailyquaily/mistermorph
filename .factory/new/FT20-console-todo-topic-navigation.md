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
