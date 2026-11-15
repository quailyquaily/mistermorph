# Fix file-write path extraction and repeated-write completion loop

## factory · 2026-11-15 09:23

Owner request: Add the broken file-path regex and retrying bug to new status.

## Reproduction and observed failure

A task containing “Write down to the design/ folder” was interpreted as requiring a file named `the de`. Successful writes to `design/mobile-popups.md` did not satisfy the completion guard, which repeatedly emitted `file_write_required`. The interrupted run made 68 `write_file` calls instead of completing.

Investigation identified `agent/file_intent.go` (`ExtractFileWritePaths`) and the requested-write completion check in `agent/engine_loop.go` as the relevant code. The regex's whitespace escape inside a Go raw string was over-escaped: the character class excluded a literal backslash and the letter s rather than whitespace. Independently, natural-language directory instructions were treated as exact file requirements. Confirm these findings against the current implementation before changing it.

## Acceptance criteria

- Correct regex escaping and path extraction so whitespace terminates unquoted paths, while the letter s remains valid; handle quoted/backtick paths with spaces deliberately.
- Distinguish explicit file destinations from directory/prose requests. Do not extract `the de`, `the`, or similar prose as mandatory filenames, or require a directory to be created as a file. A valid write under a requested directory must not be rejected for using a sensible filename.
- Preserve explicit file-write enforcement for genuine file requests, including reporting genuinely missing output. Do not bypass the guard globally or create bogus files merely to satisfy it.
- Bound repeated completion-guard interventions and detect no progress. An unsatisfied or malformed requirement must end with an actionable diagnostic identifying the offending requirement, not an unbounded cycle of identical writes. Successful writes must not trigger redundant retries for the same fulfilled requirement.
- Cover fresh and resumed runs wherever requested-write intent is initialized or checked.
- Add regression tests for the exact reproduction phrase, explicit relative paths (including design/ and filenames containing s), quoted/backtick paths with spaces, directory-only prose, successful fulfillment, genuinely missing files, malformed intent, and repeated no-progress completion attempts. Include an engine-level test proving the reproduction cannot loop indefinitely.

Scope: runtime parser/completion-guard fix and regression coverage; no UI changes. This item records the requested fix; it does not claim implementation.
