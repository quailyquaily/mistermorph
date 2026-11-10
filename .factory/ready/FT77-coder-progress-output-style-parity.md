---
branch: factory/FT77-coder-progress-output-style-parity
round: 1
---
# Align coder output styling with progress output

## factory · 2026-11-11 00:40
Owner requested this UI fix in Console; recorded in new for implementation.

Request: coder 的输出框样式应该和 progress 一样是暗色背景，别的样式也应该一样。

Acceptance:
- Give coder output the same dark background and visual treatment as progress output, including typography, spacing, borders and corner treatment.
- Prefer shared styling so the two output containers stay consistent; preserve their distinct content and behavior.
- Verify both output types in the chat view, including empty and populated states.

## factory · plan · 2026-11-11 04:33
Behaviour: coder output uses the progress terminal's dark surface, typography, spacing and corners; preserve streaming, selection, scrolling and status. Empty and failed output stay legible; no first-run state changes.
Scope: share terminal styling across ChatStatusCard, ChatWorkerRoster and ActivityDetailPanel, with regression tests. Exclude unrelated overflow/layout work.
Decisions: use existing progress styling as authoritative; a small shared component/constants, not a new theme system. Preserve reasoning and other content behavior.
Checking: populated, empty and failed coder output alongside progress in chat tests; nsh check, nsh tests, gofmt, go vet and go test; visual check when available.

## factory · 2026-11-11 04:33
Built 5063d39a: shared ChatTerminal surface and colours; coder labels, output, errors and no-output text match progress. Moved new/ → review/.
Decisions: output uses progress's regular font rather than monospace (code/diff columns consequently no longer align); shared subagent output also gets the terminal. Missing-worker/panel empty states remain plain, as for progress. Content and behavior retained.
Tests: nsh check and all 525 nsh tests passed; new regression test fails on old code. gofmt clean, go vet ./... and go test ./... passed, independently re-run by manager with throwaway HOME.
Visual: coder checked progress plus populated, empty and failed coder detail panels in Chrome using a temporary fixture. Desktop, Android and live workers were not checked; automated chat tests use stub data.
Installs: none.
Push initially failed because credential requests lacked repository path; succeeded with per-command credential.useHttpPath=true.

## factory · review · 2026-11-11 04:51
head: 5063d39afa48d0ff97c9228cdd7837ac4a3b3582
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD; no findings. Branch merges cleanly with master.
- Validation with throwaway HOME: gofmt clean, go vet ./... and go test ./... passed; nsh check passed; all 525 nsh tests passed.
- No installs, manifest changes, or code changes during review.
- No visual check in this review; desktop, Android and live workers were not checked. Headless tests verify wrapper and text styles, not the background colour itself.
- Intentional regular-font styling matches progress; code/diff columns no longer align.
- Moved review/ → ready/.
