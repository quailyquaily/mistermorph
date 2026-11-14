---
branch: factory/FT116-progress-command-failure-diagnostics
round: 1
---
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

## factory · plan · 2026-11-14 17:21
Behaviour: Preserve bounded, redacted command diagnostics through tool completion and saved task state. Failed shell calls show command, exit code, stderr and stdout together. Empty output is explicit; omissions and capture limits are labelled. Later status-only events must not erase diagnostics.
Scope: Shell observation parsing, Console progress transport/retention and failure rendering with regression tests. No unrelated composer changes, capture-limit expansion or new settings.
Decisions: Reuse the Progress terminal layout. Keep the existing 6000-character per-stream limit, retaining stream tails and reporting omitted characters. Commands retain line breaks up to a labelled 6000-character bound. Successful results retain their existing display.
Checking: Cover stderr plus exit 128, stdout-only failures, empty output, long/multiline commands, saved results, later events, shell subtasks/nested calls, limits and Guard redaction. Run gofmt, go vet, full Go tests, nsh check and nsh tests using repository-required nsh 0.5.0 and a throwaway HOME.

## factory · 2026-11-14 17:21
Built and pushed commits 63e50e67 and a04b8b1d (head a04b8b1d): failed bash/powershell progress keeps structured exit code and bounded stdout/stderr, survives completion and task persistence, and renders selectable diagnostics with empty/omission labels. Commands are preserved up to an explicit display bound; Guard redaction remains applied. Added backend, parser, state-normalisation and UI tests with English/Chinese/Japanese strings.
Installs: none; reused the existing repository-compatible nsh 0.5.0 tool.
Tests: manager independently passed gofmt, go vet ./... and go test ./...; nsh 0.5.0 check passed. Full nsh suite after retry: 921/922 passed, all five new diagnostic UI tests passed. Failing test: `chat-composer-drum.test.tsx:43:29: expected 0 to be 1`. The coder reproduced the same timing failure on base 75eec416 (3/10 runs) and HEAD (4/10 runs); unrelated composer code was left unchanged. The retry's sole failure was the linux variant; the previous run's sole failure was android. An initial manager run used system nsh 0.4.0 incorrectly; those incompatible-version results were discarded.
Not checked: no visual inspection in browser, desktop or Android; tests cover text/structure, not manual appearance. Live output while running remains unchanged. Review should inspect retention/redaction and long diagnostics, plus assess the documented base timing flake.
Moved new/ → review/, round 1. First push needed command-local credential.useHttpPath=true; retry succeeded without settings changes.
