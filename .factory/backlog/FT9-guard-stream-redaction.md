---
branch: factory/FT9-guard-stream-redaction
round: 3
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


## factory · review · 2026-11-04 22:51
head: 1d720135ebd54204513bf81b3d251e69bbcfa266
verdict: fix
fix:
- [P1] cmd/mistermorph/consolecmd/stream_events.go:135: Coder progress formatting inserts status/newlines between fragments of a single command line before redaction. A split 24-character API-key value was emitted as two unredacted fragments (8 and 16 characters) in Console frames. Preserve raw per-command increments and redact before adding formatting or previews.
- [P1] guard/stream_redact.go:135: Flush clears the unterminated private-key state but subsequently emits the pending final body fragment. BEGIN followed by a body without a trailing newline leaks that body after the redaction marker. Consume or discard partial along with the entire unfinished key block.
- [P1] guard/stream_redact.go:240: Line-by-line release does not preserve the built-in environment-variable pattern's quoted multiline values. A quoted MISTER_MORPH value containing two lines hides the first line but exposes secondSECRET123456 on the second; whole-string redaction hides both. Hold quoted values through their closing quote, failing closed at the buffer limit.
- [P1] guard/stream_redact.go:235: Releasing the 64 KB buffer can split an unfinished custom multiline match. With pattern `(?s)<secret>.*?</secret>`, 13105 repetitions of `safe
` before a secret block cause SENSITIVEPAYLOAD123456 to appear in Console frames. Do not release unconfirmed content at the cap; fail closed when match boundaries cannot be established.
- [P1] agent/coder_tool.go:873: Preview truncation still precedes redaction. A custom secret block starting before the preview cut and ending after character 1000 loses its closing delimiter, so the Console emits its payload. Redact complete raw content before preview truncation.
notes:
- [P2] agent/coder_tool.go:873: Guard-off previews also use the new line-boundary truncation. A status plus an 1100-character output line now becomes only an ellipsis instead of the previous 1000-character preview. Preserve the previous path when Guard is disabled.
- Codex reviewed origin/master...HEAD, base 2bce552ee9e2c604830ea600ef7be055f3e71df0, covering all seven changed files. No merge conflicts.
- Required gofmt check, go vet ./..., and go test ./... passed. Six targeted overlay reproductions exposed the defects above; five leak cases were confirmed in Console frames. Targeted baseline collector/sink comparisons passed. Source worktree remained clean.
- Installs: none. Tests used an absolute throwaway HOME. No frontend source changes; pnpm not run.
- Not checked: live Codex/Claude Code integration in a browser. No linked issues or PRs. Item stays in review/ for the owner to decide; add a note and move to new/ to request fixes.

## lyric · 2026-11-04 23:02
could you fix them?

## factory · 2026-11-04 23:02
Fix round 2 in the owner's checkout at the owner's request: commit 6044edb2, on 1d720135.

- [P1] coder formatting: the coder now sends status lines and each command's raw output separately. A new `agent.Event.Part` names the Codex command item, and the Console keeps one redactor per part. `aggregated_output` is read untrimmed, and a finished command's last line is closed with a newline. Nothing formats or cuts output before Guard.
- [P1] Flush: an unclosed key block's last line is dropped with the block, including a BEGIN line without a newline.
- [P1] quoted `MISTER_MORPH_*` values: held until the closing quote. Past 64 KB they are hidden up to that quote.
- [P1] 64 KB limit: held text is hidden instead of released, along with the rest of the open match. With a multi-line custom pattern, that is the rest of the stream (`[rest of output hidden: …]`). After a dangling line, the line is kept as context.
- [P1] preview cut: removed from `agent/coder_tool.go`. The chat trace cuts its own 1000-character preview of each piece; the Console keeps its 6000-character tail.
- [P2] with Guard off, a long line is shown again instead of "…".
- Also: held state is tracked as lines arrive, since the first version rescanned everything held on each line (quadratic; a 64 KB test took 24 s and now takes 0.04 s).

Tests: one regression test per finding, using the reviewer's reproductions (split 24-character key, key without a trailing newline, two-line quoted value, `safe` repeated 13105 times before a custom block, a custom block across character 1000, and the Guard-off long line). The Console test fails when the per-part key is removed. gofmt, `go vet ./...` and `go test ./...` pass; guard, Console and agent tests pass under `-race`.

Not checked: a real Codex or Claude Code run in the Console with Guard on.


## factory · review · 2026-11-04 23:21
head: 6044edb290c3f6bfd5465801c197cfa2b7ccea22
verdict: fix
fix:
- [P1] cmd/mistermorph/consolecmd/stream_events.go:138: Coder stderr prefixes and Claude text TrimSpace still alter raw content before redaction. stderr `api_key=\nabcdefghijklmnopqrstuvwx\n` exposes the value with a `[codex stderr]` prefix; Claude chunks `Bearer ` and `abcdefghijklmnopqrstuvwx` expose the concatenated token. Pass independent unmodified raw streams through Guard before formatting.
- [P1] guard/stream_redact.go:238: dropLongLine releases held unfinished matches and clears context. With custom pattern `(?s)<secret>.*?</secret>`, `<secret>\nSENSITIVEPAYLOAD123456\n` followed by 65,537 x characters and `\n</secret>\n` exposes the payload in Console; quoted multiline environment values also leak after the long line. Discard unconfirmed content and retain skip state; handle BEGIN markers within discarded lines.
- [P1] guard/stream_redact.go:281: An oversized private-key block clears the surrounding custom-match or quoted-environment-value context. A custom secret block containing a private key over 16 KB followed by END, then `SENSITIVEPAYLOAD123456\n</secret>`, exposes that payload in Console. Preserve outer match state or hide the rest of the stream when boundaries are uncertain.
notes:
- [P2] guard/stream_redact.go:277: Adjacent END and BEGIN markers on one line lose the second key block. `-----END RSA PRIVATE KEY----------BEGIN RSA PRIVATE KEY-----` followed by a second body containing `SENSITIVEPAYLOAD123456` exposes the body. Continue scanning after END for another BEGIN.
- Codex reviewed all nine changed files in origin/master...HEAD, base 2bce552ee9e2c604830ea600ef7be055f3e71df0. No merge conflicts. Previous six regression cases pass, but eight additional synthetic-secret reproductions confirm Console leaks; all eight baseline Console-filter controls pass.
- Required gofmt check, go vet ./..., and go test ./... passed. Tests used an absolute throwaway HOME. No installs. No frontend changes; pnpm not run. Source worktree remained clean.
- Not checked: real Codex/Claude Code browser integration; CLI reproductions used fake processes. No linked issues or PRs. Item stays in review/ for the owner to decide; add a note and move to new/ to request fixes.

## lyric · 2026-11-04 23:27
sure

## factory · 2026-11-04 23:27
Fix round 3 in the owner's checkout at the owner's request: commit 83f14960, on 6044edb2.

The round 2 findings came from recovery logic: separate trackers for keys, quotes, long lines and held text, where one recovery path cleared another's state. The redactor is rewritten around one rule instead: it never recovers. When held text or a single line passes 64 KB, nothing held is released and the rest of the stream is hidden behind `[rest of this output hidden: it could not be checked for secrets]`.

- [P1] coder raw content: stderr and the assistant's text are now raw parts of their own, like command output (`stderr`, `text`). There is no `[codex stderr]` prefix, and Claude and Codex text deltas are read untrimmed. This also stops spaces between streamed words being dropped.
- [P1] long line inside an open match: the rest of the stream is hidden; nothing is released and nothing recovers.
- [P1] oversized key inside a custom block: the separate 16 KB key limit is gone. A key inside a custom block is held with the block to its end, or the rest is hidden past 64 KB.
- [P2] END and BEGIN on one line: markers are followed in order on each line.

Tests: each reviewer reproduction is a regression test (stderr `api_key=` with its value on the next line; Claude `Bearer ` and token in two pieces; a long line inside a custom block, a quoted value and a key block; an oversized key inside a custom block; END and BEGIN on one line). The all-chunk-sizes check now also covers a two-line quoted value and a key/value split by a blank line, and still equals whole-text redaction. gofmt, `go vet ./...` and `go test ./...` pass; guard, Console and agent tests pass under `-race`.

Trade-off: after a 64 KB line, or 64 KB of held text, nothing more of that stream is shown until the call ends.

Not checked: a real Codex or Claude Code run in the Console with Guard on.


## factory · review · 2026-11-04 23:51
head: 83f14960f89d8e87db5cccf46e54d3981e2b184e
verdict: fix
fix:
- [P1] cmd/mistermorph/consolecmd/stream_events.go:138: Claude tool-input JSON serialization and complete-message text trimming still alter content before Guard. Example: a tool-input API-key assignment with its value on the next line is serialized with escaped newlines; two text blocks containing a bearer prefix with a trailing space and a credential lose the separating space. Both expose the synthetic secret in Console. Redact decoded input before serialization and preserve text-block whitespace (agent/coder_tool.go:878,1124,1155).
- [P1] guard/stream_redact.go:131: Flush cuts an unfinished private-key suffix before redacting the enclosing buffer, destroying outer match context. Example: a custom multiline secret block or quoted environment value contains a secret followed by an unmatched private-key opener and the outer closing delimiter. Cutting that suffix removes the outer closer and exposes the preceding secret. Redact intact held content first or hide the whole uncertain buffer.
- [P1] agent/coder_tool.go:479: Oversized stderr lines are discarded before Guard sees them (also line 650). Example: a line over four MiB containing a private-key opener is dropped, while subsequent body and closing lines are forwarded and the body is exposed. Suppress the remainder of the stream on overflow or explicitly signal fail-closed state to Guard.
notes:
- [P2] guard/stream_redact.go:20: Continuation detection omits form feed, unlike the built-in whitespace pattern. Example: an API-key separator followed by form feed, newline and its value is hidden by whole-text redaction but exposed by streaming. Match the built-in whitespace semantics.
- [P2] guard/stream_redact.go:169: A quotation mark inside a private-key block prematurely closes an enclosing quoted environment value. Example: the enclosing value continues with sensitive text after the key block; whole-text redaction removes the key first and hides that text, but streaming releases it. Track quotes consistently with private-key removal or conservatively hide overlapping matches.
- Codex reviewed all nine changed files in origin/master...HEAD, base 2bce552ee9e2c604830ea600ef7be055f3e71df0. No merge conflicts. Seven synthetic-secret overlay reproductions confirmed Console leaks; all seven baseline Console-sink controls passed.
- Required gofmt check, go vet ./..., and go test ./... passed; race tests for guard, agent and Console passed. Tests used an absolute throwaway HOME. No installs or frontend changes; pnpm not run. Source worktree remained clean.
- Not checked: real Codex/Claude Code browser integration. Existing persistent-terminal path is not proven to satisfy live line-by-line output acceptance. No linked issues or PRs. Item stays in review/ for the owner to decide; add a note and move to new/ to request fixes.

## lyric · 2026-11-05 00:03
Shelve FT9

## factory · 2026-11-05 00:03
Shelved after three review rounds, all with verdict fix (heads 1d720135, 6044edb2, 83f14960). Each round fixed what was reported, and the next found new ways for line-by-line streaming to leak, because it has to reproduce Guard's regular expressions on text not yet seen: cross-line whitespace, quoted values, nested key blocks, content changed before Guard (trimming, prefixes, JSON escaping, dropped long lines).

Left for when this is picked up again:
- The branch `factory/FT9-guard-stream-redaction` (83f14960) is kept. It has useful parts apart from the redactor: coder status lines are sent apart from raw output, and each command's output, stderr and the assistant's text form raw parts (`agent.Event.Part`). Codex and Claude text deltas are read untrimmed, which also fixes dropped spaces in streamed text with Guard off.
- The suggested next approach: redact each finished unit whole (a command's output, a message, a decoded tool input, stderr), which equals whole-text redaction by construction. Status lines stay live; output appears when its unit ends.
- The open findings of the last review are above.

Nothing was merged; with Guard on, the Console still shows coder status lines only.
