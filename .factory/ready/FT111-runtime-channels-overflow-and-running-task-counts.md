---
branch: factory/FT111-runtime-channels-overflow-and-running-task-counts
round: 1
---
# Runtime channels: contain configuration details and show running task counts

## factory · 2026-11-14 06:52
Owner request from Console:

> When clicking the Not configured in the runtime -> channels, the section frame is overflowing.
> And I think it's also a good place to see how many tasks are running in each channel. So the console and the cli runtime should also be included as well. Add to new/

### Required behavior
- Fix the overflow in Runtime → Channels when clicking **Not configured**. Keep the resulting details or configuration guidance within the section and viewport, without content covering the frame or introducing unintended horizontal scrolling. Investigate the cause rather than assuming a particular CSS fix.
- Show the number of currently running tasks for each channel/runtime entry in this section. Include **Console** and **CLI** alongside the existing channel entries, even though these are not messaging-platform channels.
- Use actual runtime task state, not queued-task counts, total historical tasks, or guessed values. Define and consistently apply which execution states count as running; do not double-count a task across entries.
- Refresh counts with the existing runtime status update mechanism so task starts and completion, failure, or cancellation are reflected without a page reload. Show zero for an available entry with no running tasks; distinguish unavailable/unknown data from zero.
- Preserve configuration status and existing configuration actions for messaging channels. Console/CLI entries must not misleadingly require messaging-channel configuration.

### Acceptance checks
- Click Not configured for the applicable channel entries; verify details stay inside the section on desktop and narrow/mobile viewports, including long guidance text or identifiers. Opening and closing details must not break neighboring entries.
- Verify Console and CLI appear alongside existing channels, with accurate per-entry counts for zero, one, and multiple concurrent tasks.
- Start and finish/fail/cancel tasks and verify counts update; verify queued and completed tasks are excluded and unavailable status is not presented as a known zero.
- Add regression coverage for task attribution/counting and relevant UI rendering/layout. Check keyboard access and visible focus for configuration/detail controls. State any browser or live-runtime checks that could not be performed.

Status: requested only; no implementation or cause diagnosis yet.

## factory · plan · 2026-11-14 09:44
Behaviour: extend the existing runtime overview refresh with authoritative running execution counts for messaging channels, Console and CLI; known zero is distinct from unavailable/unknown. Count only TaskRunning executions, once by origin, excluding queued/terminal and steered messages. Expanded configuration details must remain in normal card flow with long text wrapping and accessible keyboard controls.

Scope: RuntimePanel and related translations/tests, backend overview and task stores needed for attribution; preserve messaging configuration status/actions. No new config, refresh infrastructure or unrelated refactor.

Decisions: use existing /overview and minute refresh; attribute Console/CLI using trigger source/ref rather than transport guesses. Diagnose nsh layout before selecting a fix; do not merely clip overflow. Missing counts remain unknown.

Checking: table-driven store/overview attribution and lifecycle tests; frontend count/unknown refresh rendering, desktop/mobile/narrow/localized layout and keyboard/focus checks. Run repository gofmt/vet/test and nsh check/test with throwaway HOME. Record unavailable real-device/channel checks.

## factory · 2026-11-14 09:44
Built in commits 1b1afcf2 and c8f18ea4, pushed head c8f18ea4. Moved new/ → review/ (round 1).

Cause: mobile stacked model/channels cards retained desktop flex-1, forcing equal heights in nsh instead of content height; expanded content overflowed. Apply flex-1 only side by side and allow long names/statuses to shrink/wrap. Added keyboard-focus rings and a PORTING note.

Counts: only TaskRunning, excluding queued, approval-pending, terminal and steered executions. Console UI triggers count as Console; chat and cli/chat API triggers as CLI. Managed/standalone channels count their own authoritative stores; Agent Link and non-channel background work excluded. Shared Console store refresh removes stale dead chat-process runs. Missing/unavailable counts remain unknown. Existing minute refresh means up to one minute of lag.

Verification: manager independently reran configured gate `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`: PASS. Protected paths unchanged; only the two item commits since start point 75eec416. nsh check PASS. Full nsh suite: 926/927 passed; unrelated intermittent failure `chat-composer-drum: typing turns the drum`, also reported on master by coder; isolated reruns failed twice out of three. Recorded rather than changing unrelated code. New backend, frontend behaviour and four layout tests pass.

Browser/live checks: Chrome 1280/390/320 widths, Japanese narrow layout, no horizontal overflow; keyboard Tab/Enter/Space and visible focus checked. Mock-LLM live Console + CLI-API task running counts returned to zero without reload (tasks ended failed due mock response format). Not checked: real morph chat shared-process execution, real messaging accounts, desktop application, Android device/emulator, screen reader. Closed Collapsible omits aria-expanded=false in nsh upstream.

Installs: none. Initial branch push failed because credential helper needed credential.useHttpPath=true; one retry with command-scoped option succeeded. No secrets/settings changed.

## factory · review · 2026-11-14 10:11
head: c8f18ea46570ab1b8f34ea4db31e392e00b579a8
verdict: pass
notes:
- [P3] web/console-nsh/pages/settings/RuntimePanel.tsx:363-369: a failed refresh retains the last known running-task counts. Example verified with a throwaway nsh test: first response has console=0, cli=0, telegram=2; next refresh returns 502, yet entries still show zero/zero/two alongside the panel's Stale data warning. Clear running_tasks on a current refresh error or render counts unknown while err is set; add failed-refresh coverage.

Reviewed by Claude Code: origin/master (75eec416) ... c8f18ea4, both item commits and all 12 changed files. Attribution, steered-task exclusion, store lifecycle, state filtering, unknown values, layout and protected paths reviewed. No P0/P1 findings; review/ → ready/.

Validation: configured gofmt/vet/go-test gate PASS with throwaway HOME; nsh check PASS. Full nsh suite 925/927 passed: the two failures are linux/android variants of existing chat-composer-drum “typing turns the drum”. Isolated repeated tests verified this on base (3/4 failures) and head (2/4 failures); unchanged composer, not an introduced failure. New item tests pass. Stale-count reproduction confirmed in a scratch frontend copy; tracked worktree clean, no commits or edits by reviewer. Installs: none.

Residual risks: no live real morph-chat/shared-store process, messaging accounts, desktop app, Android device or screen-reader verification in this review. Counts retain the existing one-minute polling delay. The overview adds another shared-store journal read/lock per poll; not load-tested. No linked issue/PR in the item, so no GitHub review comment required.
