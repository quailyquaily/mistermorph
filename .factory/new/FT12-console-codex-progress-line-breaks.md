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
