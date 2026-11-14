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

## factory · review · 2026-11-14 17:48
head: a04b8b1df15ca0a3f75d53bbb335cb23e879a19d
verdict: fix
fix:
- [P1] tools/builtin/shell_runner.go:337; cmd/mistermorph/consolecmd/activity_progress.go:525: Normal failed shell calls receive an engine-added `\n\nerror: <tool error>` suffix (agent/engine_loop.go:1103), which the new parser incorrectly retains as command stderr. Verified through the real Engine with Guard on and off: `exit 3` persists stderr `\n\nerror: bash exited with code 3`, so the required no-output indicator never appears; stdout-only failure likewise falsely reports stderr. Strip only the matching engine error suffix before parsing (accounting for Guard redaction and the elevation hint), without dropping genuine command output. Add engine-driven stderr/exit128, stdout-only, empty-output and success regressions, including codemode; direct tool.Execute fixtures currently bypass the triggering engine path.
notes:
- Review by Claude Code on origin/master...HEAD (merge base 75eec416bc30834943e2297cb4d6cfe83299bfce). All 12 changed files inspected; diagnostic retention, redaction and serialization checked. No additional confirmed security finding.
- Validation: configured gofmt check, go vet ./... and go test ./... passed; nsh 0.5.0 check passed; task-history Node tests 22/22 passed. Full nsh suite 920/922 passed; linux/android composer drum variants failed at chat-composer-drum.test.tsx:43:29 (`expected 0 to be 1`). Isolated repeats reproduced the identical pre-existing failure on base (5/6 runs) and head (2/6), so unrelated composer code should not be changed for this item.
- Engine-shaped diagnostic UI reproduction failed 2/5 checks, confirming the empty-output and exact-stderr regression. Reproduction used a throwaway source copy, not source-tree edits. Reviewed worktree remains clean.
- Installs: none; reused repository-compatible nsh 0.5.0. Scripted tests used a throwaway HOME.
- Residual risks: no manual browser/desktop/Android inspection; retained task payload can be several MB at maximum bounded history. Timeout exit-code presentation was not established as a separate introduced defect.
- Round 1 of max_rounds 3: moved review/ → new/ for the next fix round. No linked issue or PR was named in the item, so no GitHub review comment was required.
