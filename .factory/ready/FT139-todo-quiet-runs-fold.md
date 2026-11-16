---
branch: factory/FT139-todo-quiet-runs-fold
round: 1
---
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

## factory · plan · 2026-11-16 22:02

### Behaviour
After a scheduled TODO run successfully ends done, classify task text and final output using one decision-route llm.Evaluate Choice (result/nothing/problem); persist valid answer beside final. Manual, failed, stopped, heartbeat and unchecked runs retain existing full presentation. Missing explicit decision profile, invalid answer or call failure must not change success or conceal the run. Consecutive eligible nothing runs in TODO topics form a pressable centred summary, including singleton groups; expanded summaries show time and single-line replies, selectable for full in-place rendering. In-progress/nonquiet/manual/unchecked runs break groups. Quiet completions neither reorder sidebar topics, mark unread nor notify.
### Scope
Implement backend decision dependency and finish-result classification; propagate outcome through Console data and history grouping and sidebar/notification logic. Reuse context notice styling and Agent Link folds, page-owned ChatRowContext.folds state. Translate strings in all supported locales. Add gallery example, inventory and docs updates. Change only the design document's status to implemented. No backfill, deletion, other-channel or Awareness-topic folding; preserve ordinary notifications and error behavior.
### Decisions
Keep result/nothing/problem; invalid/missing classifier fails open. Selecting an expanded row reveals the original run in place. Group identity based on first member's stable id, state outside recycled rows. Use repository-pinned nsh 0.5.1 (AGENTS.md takes precedence over stale factory example version) and existing decision-route resolution patterns; never substitute main route when no explicit decision profile exists. Follow existing run timestamp semantics for quiet sidebar suppression without discarding records.
### Checking
Go table tests: each answer, route absent/error/invalid choices, scheduled-only done eligibility and timeout/cancellation fail-open behavior. Console tests: singleton/consecutive grouping, every group boundary, expansion/full-row selection and retained fold state, locale coverage, quiet unread/order/notification suppression. Gallery and inventory consistency tests. Required gate: test -z "$(gofmt -l .)" && go vet ./... && go test ./...; nsh check and scripts/test.sh for Console changes, rerun failed files individually. Scripted tests use throwaway absolute HOME under build directory while retaining explicit package cache settings. UI visual verification if available; explicitly report if not performed.

## factory · 2026-11-16 22:02

Built in three focused commits: a454c980 (decision-route outcome check), 0ea075da (Console folds and surrounding topic behavior), 7162afcd (documentation). Branch head: 7162afcd.

Scheduled successful TODO runs receive a fail-open decision Choice with result/nothing/problem; manual, failed, stopped and Awareness runs remain unchanged. Quiet runs fold in TODO history with per-group/per-run state, all three locales, shared notice styling, gallery demos and inventory. Quiet completions do not reorder topics, mark unread or notify. Design status marked implemented.

Decisions: classification has a 30-second deadline and happens before finish recording. Scheduled topic ordering updates at completion rather than start; manual behavior is unchanged. Empty replies and runs without a task record remain unchecked. Group identity uses first loaded member; loading earlier history that extends the group backwards can reset expansion.

Installs: none.

Tests: required gofmt/vet/go test gate passed under throwaway HOME, independently repeated by manager. Coder also reports race tests for awareness and daemonruntime passed; nsh 0.5.1 check clean; required scripts/test.sh passed 129 files, zero failed. New regression coverage includes classification answers/fail-open/eligibility/deadline/cancellation, topic order/unread/notification behavior, grouping boundaries and expansion, locales and gallery inventory.

UI: coder checked headless Chrome at desktop 1400x1000 and mobile 390x844, folding, hover, expansion, full run display, keyboard Enter, and en/zh/ja gallery. Not checked: live decision-model request, native desktop GPUI or Android. No pre-existing base failures reported.

Moved from new/ to review/.

## factory · review · 2026-11-16 22:29
head: 7162afcd89a23ad0410225893c315fb278d31dc9
verdict: pass
notes:
- [P3] internal/daemonruntime/console_store.go:276: a scheduled run interrupted by a runtime restart no longer moves its TODO topic up. Upsert now defers topic activity until completion, but recoverNonTerminalTasksLocked cancels interrupted runs without touching their topic. Verified with a Go overlay probe: topics ordered _cron_other,_cron_todo remain in that order after a scheduled run in _cron_todo and reopening the store; the run becomes canceled with "runtime restarted". Touch the topic during scheduled-run restart recovery and add regression coverage.

Claude Code reviewed all 27 changed files against origin/master...HEAD. No P0/P1 findings. Required gofmt/vet/go test gate passed; nsh 0.5.1 check passed; required Console scripts/test.sh passed 129 files, zero failures, using throwaway HOME. Worktree remained clean. No reportable installs; nsh restored TypeScript 7.0.2 in its disposable cache.

Limits: no live decision-model request or independent visual/native desktop/Android check during review. Task text and final output go to the configured decision provider; model-output prompt injection can misclassify a useful result as nothing, although records remain readable. Classification may delay finish recording by 30 seconds. Loading older history can reset a fold's expansion when its first member changes. Multi-day fold time-span labels were not independently verified.

Moved from review/ to ready/. The restart ordering P3 is a follow-up for the owner.
