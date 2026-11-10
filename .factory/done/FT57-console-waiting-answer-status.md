---
branch: factory/FT57-console-waiting-answer-status
round: 1
---
# Show waiting-for-answer status when an agent asks a question

## factory · 2026-11-10 08:42
Registered from the owner’s request.

User report: "When the agent asked me a question, the status mark was not correct(it's running, except for pending or waiting for an answer"

When an agent asks the user a question and is blocked awaiting their answer, show the appropriate pending/waiting-for-answer status rather than running. Prefer a clear waiting-for-answer label if supported by the existing status design. Ensure the displayed state reflects the real task lifecycle, including after reload/reconnection. Resume running when the submitted answer lets execution continue, and preserve correct completion, cancellation, error, and timeout states.

Check the status mark in chat and related topic/task views for consistency. Add regression coverage for entering the waiting state, restoring it, and leaving it after an answer. Do not label ordinary queued work as waiting for a user answer.

## factory · plan · 2026-11-10 10:32
Behaviour: Display waiting-for-answer for active tasks with an open user question, including after reload/reconnection; resume running after answer or expiration. Terminal states take precedence. Empty questions and queued work keep their existing state.
Scope: Task question lifecycle projections and Console chat, topic and task status rendering; regression tests. No scheduler-state changes or unrelated layout/config changes.
Decisions: Derive presentation from real open questions rather than reuse approval pending or queued. Add minimal response projections where list/detail lack the information; preserve polling and existing execution lifecycle. Translate the label consistently.
Checking: Open, restore, answer, expiry, stopped/terminal and queued-negative coverage; configured Go suite and Console checks; browser lifecycle check where feasible.

## factory · 2026-11-10 10:32
Built and pushed aaa11022 and eef8815a. Added transient awaiting_answer task projection and waiting topic activity/count, backed by open runtime questions. Chat, Progress, topic list and Audit now display waiting-for-answer; stream question state avoids stale polling after an answer. English, Chinese and Japanese labels added. Approval precedence and terminal status preserved. Telegram/Slack runtime wiring included.
Installs: none; no dependency changes.
Tests: configured gofmt check, go vet ./..., and go test ./... passed; manager independently reran them successfully. Coder reports nsh check, all 408 nsh tests, and 250 core Node tests passed.
Browser: coder checked the real Console with a fake model server: waiting marks, reload restoration, answer-to-running transition and terminal mark clearing. Fake model final response was malformed, so the run ended failed; successful completion was not manually verified in this browser scenario.
Not checked: native phone/desktop builds on devices and live Telegram/Slack runs (unit coverage only). Older Console builds do not recognize waiting topic activity; backend and Console should ship together.
Move: new/ → review/. Ready for independent review; not merged to master.

## factory · review · 2026-11-10 10:48
head: eef8815a8644d9b65631dfa0f9fdfb4bf7152ccc
verdict: pass
notes:
- [P2] web/console-nsh/lib/core/chat-task-history.js:487: Cached questions unconditionally override newer polling state. After an open question is streamed, disconnecting the WebSocket and answering or expiring the question leaves the running task without result.questions; polling clears awaiting_answer but retains the cached open question, so chat/progress stay waiting while topic/Audit show running. Conversely, cached answered questions hide a subsequent open question. Reconcile stream and polling freshness/connection state and cover running responses without result.questions. Codex reproduced both mismatches with actual functions: server false/chat true after answer, server true/chat false for a later question.
Validation: Codex reviewed all 22 changed files in origin/master...HEAD. Configured gofmt check, go vet ./..., and go test ./... passed; nsh check passed; nsh tests 408/408 and core Node tests 250/250 passed. Scripted tests used an absolute throwaway HOME. Working tree remained clean.
Installs: none.
Not checked: real-browser disconnection, native devices, live Slack/Telegram. Finding reproduced through code paths and scripts.
Move: review/ → ready/ under the no-P0/P1 review gate. P2 remains for owner consideration; not merged.

## factory · 2026-11-10 23:38
Merged into master at cbc9e6859ead016bafa78a5cb56bf92eb09d3867. Released in v0.3.93; base and annotated tag pushed atomically. Moved ready/ → done/.

Validation on the final integrated base: manager gofmt cleanliness, go vet ./... and go test ./... passed; nsh 0.4.0 check passed and full console suite passed (524/524). Tests used a throwaway HOME. The first final console run exceeded the tool timeout and was confirmed stopped before the successful rerun. after_change is empty. No forbidden paths changed.

Linked issues/PRs: none (no source or owner closure links); nothing to close. Installs: none. Native desktop windows, real Android/device rendering, Windows/macOS and real IME/accessibility were not verified during ship; existing review notes remain.
