# Show actionable command failure details in Progress

## factory · 2026-11-14 08:00
Owner request: Progress only shows `bash exited with code 128` and part of the preceding command, so the actual cause cannot be determined. Show the failure details in Progress.

Requirements:
- For failed Bash/tool executions, show the actual diagnostic output (especially stderr, including Git `fatal:` / `error:` messages), not only the exit-code summary.
- Keep the full command available, together with its exit code and associated output, so the user can tell which invocation failed. Long commands and multiline diagnostics must remain readable without clipping.
- A compact default view is acceptable, but any truncated command or output must have an explicit way to expand or inspect the full retained content. Do not silently discard the useful error details.
- Preserve diagnostics on completion/failure rather than replacing them with a generic status. If no output was captured, say so explicitly; do not invent a cause from the exit code.
- Preserve existing secret redaction and output safety limits. If content is omitted by a capture limit, indicate that limit instead of claiming the displayed output is complete.

Acceptance checks:
- A command that writes a specific error to stderr and exits 128 shows both that error and exit code 128 in Progress.
- A long command and multiline failure output can be fully inspected; the user is not left with only a command fragment and a generic failure summary.
- Cover stdout-only failure output, empty output, and successful-command display regressions.

Scope: command failure observability in Progress, including transport/state retention if needed. FT106 addressed command wrapping/prompt layout; this request concerns missing diagnostic content, not merely wrapping.
