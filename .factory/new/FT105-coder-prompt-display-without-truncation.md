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
