---
branch: factory/FT12-console-codex-progress-line-breaks
round: 1
---
# Console: preserve line boundaries in Codex subagent progress output

## factory · 2026-11-05 10:56
Owner requested a new-status repair item after pulling master. Reported symptom: Codex subagent output renders consecutive status messages as `Codex is startingCodex is working`, without a line break.

### Expected behavior
- Separate Codex lifecycle/status messages remain separate readable lines in live subagent output and restored task history.
- Preserve actual output whitespace and indentation; do not insert newlines into arbitrary streamed text chunks or split genuine partial lines.
- Keep plain-text monospace rendering and existing Claude Code behavior intact.

### Investigation notes
Checked master at 353bdd87. `internal/coderterm/session_unix.go` emits standalone starting/working status strings. The terminal adapter in `internal/channelruntime/taskruntime/runtime.go` already supplies `status+"\n"` as event text. Console activity and worker output concatenate event text in `cmd/mistermorph/consolecmd/activity_progress.go`. Trace the complete event, persistence, transport and rendering chain to identify where line boundaries are lost; do not assume the producer alone needs a newline.

### Acceptance criteria
- Reproduce consecutive starting/working messages with a regression test and fix the actual boundary-loss point.
- Cover live progress, worker/subagent output, and persisted/reloaded history where applicable.
- Cover already newline-terminated statuses, partial text chunks and repeated working notifications without blank-line inflation or text corruption.
- Run relevant Go tests and frontend tests/build for changed console sources. Record whether browser verification was performed.

This item is queued in new; no implementation or repair verification has been performed.

## factory · plan · 2026-11-05 11:07
Behaviour: Preserve separate Codex lifecycle status lines through live activity, workers, transport and restored history. Preserve genuine raw chunks, indentation and existing line endings. Empty output, first-run and error behavior remain unchanged.

Scope: Trace terminal producer through runtime, Guard preview sink, console accumulation and persistence/frontend. Repair the actual boundary-loss point; retain Claude behavior and plain-text monospace rendering. No unrelated refactoring or heuristic repair of old corrupted history.

Decisions: Complete status summaries are records, while raw CLI output is streamed text. Restore a missing terminal newline only on the Guard-redacted status replacement, not arbitrary output chunks.

Checking: Reproduce starting/working concatenation; cover existing newlines, repeated statuses, empty and partial output, indentation, live activity/worker output, JSON and journal restoration, and frontend rendering. Run repository Go checks and frontend tests/build; record browser coverage.

## factory · 2026-11-05 11:07
Built and pushed d7eeea3c (fix(console): preserve coder status line endings through Guard).
Root cause: the Guard preview sink replaced newline-terminated event text with a status summary without its newline. The replacement now adds a terminal newline only when missing; raw output and already terminated summaries are untouched.
Regression coverage includes live activity and worker output, JSON transport, persisted/reloaded journal history, partial chunks and repeated statuses; frontend worker restoration/rendering tests were extended.
Tests: gofmt check, go vet ./..., and go test ./... passed, independently rerun by manager with throwaway HOME. Coder also passed focused regression tests, pnpm test (388 tests), and pnpm build (bundle-size warning only). Regression reproduced before fix.
Installs: no unpinned tools or manifest/lockfile changes.
Not checked: interactive browser verification was not performed; frontend restoration and server-rendered output were tested. Existing corrupted history is not retroactively repaired.
Moved new/ → review/. Owner should inspect status line separation in live and reloaded Console worker output.

## factory · review · 2026-11-05 11:16
head: d7eeea3c77bb6cc8156f3c13ebc04b9831b15132
verdict: pass
notes:
- Codex reviewed origin/master...HEAD (base 353bdd87b6b839543c7c110ef84f99df4ccb6376): no findings. Traced status production, Guard replacement, activity/worker accumulation, transport, history restoration and frontend rendering.
- Validation passed with a throwaway HOME: gofmt check, go vet ./..., go test ./..., pnpm test (388 tests), and pnpm build (bundle-size warning only).
- No unpinned installs or manifest/lockfile changes; review left tracked files unchanged.
- Interactive browser verification was not performed. Existing corrupted history is not retroactively repaired. Owner should inspect separate status lines in live and reloaded worker output before shipping.
- Moved review/ → ready/. No linked GitHub issue or PR to comment on. Not merged into master.
