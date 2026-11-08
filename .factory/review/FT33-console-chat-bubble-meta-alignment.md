---
branch: factory/FT33-console-chat-bubble-meta-alignment
round: 1
---
# Console: align the progress and the time above a chat bubble

## lyric · 2026-11-08 23:17
The progress and the date/time shown above a chat bubble should be aligned with each other.

Where: the status line above the bubble (`statusMark` in `web/console-nsh/components/chat/ChatHistoryItem.tsx`) and the progress shown next to it.

## factory · 2026-11-09 00:05
Moved from backlog to new at the owner’s request: “Move FT 31~34 to new”.

## factory · plan · 2026-11-09 01:15
Behaviour: vertically centre the agent timestamp/duration with adjacent plan, progress and reasoning controls, including running, completed, failed and reasoning-only replies. Missing time must not hide progress; standalone reply and sent-message timestamps keep their existing alignment and interactions.

Scope: minimal status-line layout fix and regression tests; no unrelated UI or state changes.

Decisions: use the summary row's centre alignment instead of fixed offsets; retain standalone left alignment and sent-message right alignment. Preserve narrow-screen wrapping, click targets, duration tooltip and icon.

Checking: layout regression tests for summary prefixes and standalone timestamps; nsh check, nsh web-host tests, and configured Go formatting/vet/tests. Visually inspect if available, otherwise explicitly record the gap.

## factory · 2026-11-09 01:15
Built and pushed 72f60754 (fix(console-nsh): centre a reply's time with its progress).

Extracted ChatStatusMark with summary/reply/sent placement. Summary placement no longer overrides its parent's items-center with self-start; standalone reply and sent-message placements retain their original alignment. ChatStatusCard and state handling are unchanged.

Six layout regressions cover running, completed, failed and reasoning-only replies, missing timestamps and standalone reply/sent alignment. The four centre-alignment tests failed against the old placement by 2.5pt and pass with the fix.

Tests: nsh check passed; nsh test --web-host tests/noHost.js passed (277 passed, 0 failed). Configured test `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed, independently rerun by the manager. Tests used throwaway HOME directories. No unpinned tools or dependencies installed; no forbidden paths changed.

Not checked: actual UI appearance in a browser or desktop app. Headless Chrome did not fetch the local test page; only headless layout measurements were obtained. Narrow-window wrapping needs a manual look and has no dedicated regression test. Layout tests exercise the extracted component inside the summary line, not the ChatHistoryItem placement wiring.
