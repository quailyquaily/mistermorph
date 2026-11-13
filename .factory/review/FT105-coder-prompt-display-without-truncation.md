---
branch: factory/FT105-coder-prompt-display-without-truncation
round: 1
---
# Show the full coder prompt in the Console activity popup

## factory · 2026-11-13 08:33
Owner request: "Ok. I don't want it to be truncated. Add this bug issue to new/"

The request refers to the prompt shown above OUTPUT in the coder activity popup, not the coder's output stream. The displayed prompt currently ends in `...(truncated)`, preventing the owner from inspecting the full task sent to the coding CLI.

Expected behavior:
- Show the complete original coder task/prompt in the activity popup, with no display-summary truncation.
- Preserve the complete prompt through the backend-to-Console detail path rather than trying to reconstruct text from an already-truncated argument summary.
- Keep long prompts readable using wrapping and scrolling; ensure desktop and mobile layouts remain usable.
- Preserve actual CLI execution semantics: the task sent to Codex/Claude must remain unchanged.
- Compact list/status previews may remain abbreviated, provided opening the activity detail reveals the full prompt.
- Do not remove unrelated coder-output, progress-output, trace, or logging limits as a shortcut.

Investigation lead: the earlier diagnosis identified `toolDisplayArgsSummary` in `agent/engine_helpers.go` and a 240-byte tool-argument summary cap. Verify the current implementation and all intermediate detail limits before fixing; this is a lead, not a substitute for checking the current code.

Regression checks: prompts longer than 240 bytes, long multiline prompts, and Unicode text must be preserved exactly in activity detail, including their final characters; verify both live updates and restored activity details where supported. Confirm the coding CLI still receives the complete original task.

## factory · 2026-11-13 08:44
Owner scope update: "FT105 SHOULD also include subagent. Please update."

Extend this issue to subagent (`spawn`) task/prompt display as well as coder (Codex/Claude) prompts. The requirements above apply to both:
- Opening activity details must reveal the complete original subagent prompt, not an abbreviated tool-argument summary.
- Preserve the full prompt through backend events, storage/restoration where supported, and the Console detail view; wrapping and scrolling must work on desktop and mobile.
- Keep the actual prompt passed to the subagent unchanged. Compact previews may stay abbreviated; unrelated output and logging limits remain out of scope.
- Add regression coverage for both coder and subagent prompts exceeding existing preview/detail caps, including multiline and Unicode prompts with exact final-character preservation, live updates, and restored details where supported.

## factory · plan · 2026-11-13 12:34
Behaviour: Opening coder or subagent activity details shows the complete original task, preserving multiline Unicode text, surrounding whitespace and final characters during execution, after completion and after restoration. Empty tasks show no prompt. Compact previews remain abbreviated; historic truncated data cannot be reconstructed.

Scope: Trace the engine event, Console persistence/live detail transport and popup display; remove task-specific truncation only. Keep unrelated logging/output limits and worker execution unchanged.

Decisions: The current engine already raises the task preview cap to 8000 bytes, but still truncates and trims. Preserve the exact display task without a task cap. Retain it in the worker roster when the originating call leaves the 24-entry activity history. Continue honoring configured task redaction.

Checking: Cover coder and spawn beyond 240 bytes, 8000 bytes and approximately 240 KB, multiline Unicode and exact suffix/whitespace, live and persisted roundtrips, roster fallback, unchanged execution semantics, desktop/mobile wrapping and scrolling. Run the repository Go gate, nsh check and the full nsh suite with throwaway HOME.

## factory · 2026-11-13 12:34
Built with Claude Code and pushed commits 0095d888, b7dc230f and b9980932; head: b9980932. Moved new/ → review/ (round 1).

The engine preserves exact coder/spawn display tasks without the former 8000-byte cap or trimming; other argument caps and configured redaction remain. Worker roster entries retain the task so it remains available after the originating call leaves activity history. Console details preserve it through live updates and persisted reloads and no longer trim it. Worker execution retains its existing trimming semantics unchanged. Compact previews, output/progress/trace/log limits and configuration are unchanged. Old already-truncated records cannot be recovered.

Tests: Manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`. Coder passed nsh 0.5.0 check and the full suite (854 passed, 0 failed), plus 264 Node unit tests. New regressions cover both tools, long Unicode/multiline tasks with exact suffix and boundary whitespace, task redaction, real engine start/finish events and unchanged executed task, roster rollover including codemode calls, JSON roundtrips, Guard on/off live streaming and journal persistence, running/restored desktop panels and phone sheet content. New tests were checked against old code and failed as expected.

Visual inspection: Coder rendered real details using headless Chrome at widths 1280 and 390 in light/dark presentations for coder and subagent; confirmed wrapping, scroll to final line and no horizontal overflow. Not checked: physical Android device or native GPUI desktop window.

Installs: none; reused existing pinned tools. No forbidden paths changed. Initial code push lacked repository-aware credentials; the single retry with command-local credential.useHttpPath=true succeeded. Review should focus on exact-task propagation, roster retention and persistence/redaction compatibility.
