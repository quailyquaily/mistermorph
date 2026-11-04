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
