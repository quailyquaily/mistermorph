---
branch: factory/FT124-file-write-path-extraction-and-retry-loop
round: 1
---
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

## factory · plan · 2026-11-15 11:04

Behaviour: Extract explicit file destinations without consuming prose or whitespace; keep s and quoted/backtick spaces valid. Directory destinations do not mandate a fabricated filename. Genuine files remain required; successful outputs complete immediately. Missing outputs get bounded corrective reminders, then an actionable error naming the unresolved destinations. Fresh and resumed runs use the same checks and preserve the retry budget.

Scope: Runtime intent parser, completion guard, fresh/resumed state, and regression tests only. No UI or unrelated settings changes.

Decisions: Prefer high-confidence destinations over prose. Preserve case-sensitive paths and explicit extensionless quoted/anchored/known file names. Use a small total reminder cap and a no-progress cap based on the missing set; unrelated writes are not progress. Resolve output paths using runtime path roots rather than process cwd alone.

Checking: Table-driven parsing/path checks and mock-engine tests for the exact reproduction, missing and fulfilled files, malformed values, extensionless destinations, directories, partial/no progress, retry exhaustion, and resumed state. Run the configured gofmt/vet/full Go test gate in an absolute throwaway HOME.

## factory · 2026-11-15 11:04

Built in commits b7b3fb3a and 668f2709; head: 668f2709.

- Confirmed and removed the over-escaped whitespace bug; unquoted destinations terminate at Unicode whitespace, while quoted/backtick destinations may contain spaces.
- Directory/prose requests no longer create bogus mandatory filenames. Quoted/anchored extensionless paths and known filenames (including Makefile and LICENSE) retain enforcement; bare ambiguous extensionless paths remain conservative.
- Completion checks now search runtime workspace/cache/state roots and aliases as well as cwd; fulfilled writes do not trigger another reminder. Existing directory destinations are skipped.
- Guard allows at most three reminders overall and two for an unchanged missing set. Exhaustion or unavailable writing tools yields FileWriteUnsatisfiedError with offending paths and checked locations. Guard state persists through approval/resume.
- Added parser and engine-level coverage, including the exact reproduction completing in two model calls with one write, missing output, no progress, malformed intent, extensionless paths, directory-only prose, and resume budget persistence.
- Installs: none outside routine pinned module restores; no manifest/lockfile changes.
- Required test passed independently: test -z "$(gofmt -l .)" && go vet ./... && go test ./... (absolute throwaway HOME). No UI changes; no live-model run performed. Mock engine writer used rather than real builtin write_file because its package imports agent.
- Execution note: one coder focused test invocation did not retain its throwaway HOME; it used temporary test directories. The full coder gate and manager verification used throwaway HOME.
- Push initially failed because the credential helper lacked the repository path; the single retry with command-local credential.useHttpPath=true succeeded.

Moved new/ → review/ for independent review; not merged into master.


## factory · review · 2026-11-15 11:28
head: 668f27097446d3435e655eb8b535989c2dbdca2b
verdict: pass
notes:
- [P2] agent/file_intent.go:105: Dotted prose still becomes a mandatory file, and the new hard-error guard makes false positives terminate the run. Verified example: `Write to john@example.com about the delay.` extracts `john@example.com`; with an empty tool registry the engine returns FileWriteUnsatisfiedError naming that address. Reject email/prose destinations and tighten the verb boundary without excluding legitimate filenames. Extraction itself predates this change; the terminal failure is newly reachable.
- [P3] agent/file_intent.go:83: Non-ASCII sentence punctuation silently drops file enforcement. Verified example: `Please save it to report.md。` extracts no destination; strip appropriate sentence punctuation so report.md remains required.

Validation: Claude Code independently reviewed all eight changed files on origin/master...HEAD. Required gate `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed (exit 0), using an absolute throwaway HOME. Probe tests confirmed parser examples and compared selected behavior with base through Go overlays. No installs, repository edits or commits by reviewer; manager confirmed clean worktree and unchanged head. No P0/P1 findings.

Manager assessment: The reviewer's proposed fallback when no writing tool exists conflicts with this item's explicit missing-output enforcement and planned actionable errors, so it is not retained as a defect. Quoted extensionless names are deliberately supported by the plan; existing apostrophe parsing behavior is not a new regression, so those suggestions are not retained as findings.

Residual risks: No live-model, real builtin writer, or Windows execution. Stat-only checks can inspect task-supplied paths; newly expanded home paths and checked absolute locations in diagnostics were not traced through chat error presentation. Pre-existing file satisfaction and max-step forced conclusions remain unchanged.

Moved review/ → ready/. P2/P3 notes remain for owner consideration; not merged into master.
