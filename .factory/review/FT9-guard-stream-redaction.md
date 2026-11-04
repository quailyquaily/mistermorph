---
branch: factory/FT9-guard-stream-redaction
round: 1
---
# Guard: redact streamed tool output instead of dropping it

## lyric · 2026-11-04 21:47

With Guard on (`guard.enabled`, the default), the Console drops a coder's raw output while it streams and shows only status lines such as `[codex] command_execution completed (item_5) exit=0` (`cmd/mistermorph/consolecmd/stream_events.go`). Guard's redaction (`guard/redact.go`) matches complete strings, so a secret split across chunks, or cut by the 1000-character preview, would get through. Redact the stream the way inline stream inspectors do: hold back only what could still become part of a match, and release the rest once it is safe.

### Approach
- A `StreamRedactor` in `guard/`, one per stream, reusing the existing patterns.
- Line buffering: the built-in single-line patterns (JWT, bearer, `MISTER_MORPH_*`, simple key/value) cannot cross a newline, so each complete line can be redacted and released.
- Private key blocks: after a BEGIN line, hold until the END line and redact the block. With no END within a limit, release `[redacted]` instead of the held text.
- Lines over a limit (about 64 KB): fail closed. Redact and release all but a carry-over tail longer than any realistic token, or drop the line.
- Redact before truncating to the preview length.
- At the end of the stream, redact and release whatever is held.
- Custom patterns: treat one containing `(?s)` or `\n` as multi-line and hold its stream; otherwise document that custom patterns match within one line.

### Acceptance criteria
- With Guard on, the Console shows a coder's output live, line by line and redacted, instead of status lines only.
- A secret split across chunks, or across the preview cut, is never shown in part.
- A private key block is never shown, complete or not.
- With Guard off, nothing changes.
- Tests cover chunk splits inside each built-in pattern, private key blocks (complete, unterminated, oversized), long lines, the end-of-stream flush and custom patterns.

## lyric · 2026-11-04 22:32
after that, implement FT9

## factory · plan · 2026-11-04 22:32
**Behaviour**
1. With Guard on, each tool output stream in the Console (a coder's progress, a command's stdout or stderr) passes through a `guard.StreamRedactor`, one per stream (activity ID, tool, stream).
2. Text is shown a line at a time, redacted with Guard's usual patterns. An incomplete line waits for its newline.
3. A line ending in `:`, `=` or `bearer` is held until the next non-blank line and redacted together with it.
4. A private key block is held from BEGIN to END and redacted whole. With no END within 16 KB or by the stream's end, `[redacted private key]` replaces it, and the rest of its base64 lines are dropped up to END or the first line that is not base64.
5. A line over 64 KB is replaced by `[line over 64 KB hidden]`.
6. When a tool call ends, what its streams still hold is shown, redacted, before the end is handled.
7. Custom patterns with `(?s)` or `\n` hold the stream and redact it in 64 KB blocks and at the end.
8. Coder previews (1000 characters) are cut at a line break; text whose first line alone is too long becomes "…".
9. Guard off: nothing changes.

**Scope**
- `guard/stream_redact.go` and the Console event sink (`cmd/mistermorph/consolecmd/stream_events.go`); the preview cut in `agent/coder_tool.go`; `docs/security.md`.
- Left out: other channels' coder progress notifications (Telegram, Slack), which keep their current status-only text.

**Decisions**
- Redact rather than drop. Text Guard does not recognize as a secret is now shown live, as it would be in a final answer, for example a sensitive value under 12 characters.
- The built-in patterns cross a line break only through whitespace, so holding lines that end in `:`, `=` or `bearer` is enough. A line ending in a bare key whose separator starts the next line is not covered.
- Fail closed on over-long lines and key blocks. A bare base64-looking word right after an over-long key block is dropped with it.

**Checking**
- Every chunk size for a text with a JWT, a bearer token, a sensitive key/value, a `MISTER_MORPH_*` value and a key block: output equals whole-text redaction, and no 8-character piece of a secret is shown.
- Dangling lines, complete, unterminated and oversized key blocks, long lines, custom patterns, Guard off; the Console sink with a split secret and the flush at the end of the call; preview cuts.

## factory · 2026-11-04 22:32
Built outside the scheduled run, in the owner's checkout at the owner's request. Commit 1d720135 on `factory/FT9-guard-stream-redaction`, from master 2bce552e.

Built: as planned. The two Console tests that asserted the old drop-everything rule are replaced by tests of the new one.

Installs: none.

Tests: gofmt, `go vet ./...` and `go test ./...` pass; guard and Console sink tests pass under `-race`. No Console frontend change, so `pnpm` was not run.

Not checked: a real Codex or Claude Code run with Guard on, in the Console.
