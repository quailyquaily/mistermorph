# TODO topics: fold the scheduled runs that found nothing to do

## factory · 2026-11-16 21:40

Owner request:
> the cron job's topic, there are a lot message like:
> `No build performed: .factory/new/ is empty. Lock released; no notification sent`
> and
> `No review candidate: review/ is empty. No changes made and no notification sent.`
> i think for those like of messages, we can use decision route to check, if this run didn't got any meaning result, we can design a message style to fold them.

The owner then asked for the design to be written up and for it to be added here. The design is `docs/feat/feat_20261116_quiet_runs_fold.html` on master (commit 821cd34d); build what it says. Open it for the drawing of the fold, which works in a browser.

Scope and acceptance:

1. **The check (backend).** When a run that a TODO item's schedule fired ends `done`, ask the decision route one `Choice` through `llm.Evaluate`, with the item's task text and the run's final output as `State`: `result`, `nothing` or `problem`. Store the answer on the run's record as `result.outcome`, beside `result.final` (`recordAwarenessTaskFinish`, `internal/channelruntime/awareness/run.go`). Awareness runs do not get the decision client today; pass it in as `taskruntime` does for `todo_update`.
   - Failed, stopped and manual runs are not checked.
   - No `outcome` is stored when the decision route has no profile of its own, when the call fails, or when the answer is not one of the options. The run itself never fails because of the check.
2. **The fold (Console, `web/console-nsh`).** In a TODO item's topic, consecutive runs with `outcome: "nothing"` are drawn as one centred line: a hollow status dot, the count ("8 runs, nothing to do"), the time span, a caret. Pressing it opens the group: one row per run under the line, its time and its reply cut to one line, on a faint vertical rule; the task bubble is not repeated.
   - A `result` or `problem` run, a manual run, a run without an `outcome`, and a run still in progress are shown in full and end a group.
   - One quiet run folds too.
   - No new element: restyle the context-compaction notice's row (`chat-context-notice` in `components/chat/ChatHistoryItem.tsx`) and the fold of `components/chat/ChatAgentLinkExchange.tsx` (caret, hover, vertical rule). Whether a group is open is kept by the page per group (`ChatRowContext.folds`), since rows recycle.
   - Strings in every language the Console has.
3. **Around the topic.** A `nothing` run does not move the topic up the TODO list in the sidebar or mark it unread, and raises no notification.

Decisions left to the build (the doc's "Open choices"): take the simplest. Pressing an opened row shows that run in full, in place. Keep the three answers. Runs from before the check stay unchecked and in full; no backfill.

Not in scope: deleting quiet runs; the Awareness topic; other channels.

Checking: Go tests for the check (each answer, the fail-open cases, which runs are checked); Console tests for the grouping rules and for opening a group; an example in the UI component gallery (`pages/ui-components`, with its inventory and docs); set the doc's status to implemented and convert nothing else in it.
