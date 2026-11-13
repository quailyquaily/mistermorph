---
branch: factory/FT106-activity-command-wrapping-and-prompt-layout
round: 1
---
# Fix activity command wrapping and keep the shell prompt beside the command

## factory · 2026-11-13 08:42
Owner reported two display issues in the Console Progress/Coder activity details and asked to add this issue to new/:
"Here I saw 2 issues: it does not wrap. And the cmd's value is line break by the end of $, which is not a correct location to break line. Right?"

Observed behavior reported by the owner:
- Long command text does not wrap within the panel and extends beyond its right edge.
- The shell prompt marker `$` appears on a line of its own, with the command beginning on the next line even when there is room for `$ command`.

Expected behavior and acceptance checks:
- Long command text wraps within the available panel width in both Progress and Coder activity details, including narrow/mobile layouts. Long tokens must not force the panel or page wider than its container.
- Render the prompt marker and the beginning of the command together as `$ rg …`; do not insert a forced line break immediately after `$`. Subsequent wrapping follows available width.
- Preserve intentional newlines in multiline commands and preserve the actual command value, execution semantics, and copied text. Presentation must not introduce newlines into the underlying command.
- Verify actual browser rendering for short commands, long commands, unbroken long tokens, and multiline commands on desktop and mobile widths; add suitable regression coverage.

Investigation notes:
- Earlier CSS-only reasoning that the relevant text already wraps was not sufficient to establish the actual command-row behavior. Inspect the current rendering path and containing layout rather than assuming an existing pre-wrap rule covers these rows.
- The screenshot-based report does not establish whether horizontal scrolling currently works. The requested behavior here is readable wrapping, not merely adding a scrollbar.
- FT105 separately addresses truncated coder prompts; this item concerns command wrapping and prompt-marker layout, not removing unrelated output limits.
- Check the current Console implementation (web/console-nsh per factory settings); prior references to web/console Vue CSS may be obsolete.

## factory · plan · 2026-11-13 10:24
Behaviour: command values fit the available panel width in Progress and Coder details, wrapping at spaces and within oversized tokens. Keep the prompt beside the first command line, intentional newlines, highlighting and copied values. Empty commands and first render remain stable.
Scope: shared activity parameter rows, nested coder call rendering, relevant layout constraints and regression coverage. Do not change execution, unrelated output layout or FT105 prompt truncation.
Decisions: prefer the smallest nsh-compatible shared implementation; keep the presentation-only prompt separate from copied values and retain existing display limits.
Checking: short, long spaced, unbroken, multiline and empty commands; nested coder calls; desktop/mobile browser geometry and clipboard checks; nsh check, the full nsh suite and the configured Go gate.

## factory · 2026-11-13 10:24
Built and pushed commit 1d0647c9 (fix(console-nsh): activity commands wrap, with the $ beside their first line).
- Replaced sideways-scrolling parameter values with constrained wrapping rows shared by activity parameters and coder settings. The prompt occupies a narrow column beside the first command line, excluded from copied values. Preserved highlighting, intentional newlines and existing display limits.
- Nested tool calls now wrap as a single text run; their errors cannot widen the panel. Tool-name and process-label scrolling is unchanged. Updated PORTING notes and focused regression tests.
- Installs: none; existing pinned nsh 0.5.0 tooling and existing Chrome/Playwright were used.
- Verification: configured Go gate passed independently. An initial coder run hit a transient TestAttachmentInterrupted cleanup failure; three package reruns and the full gate passed. nsh check passed. Independent full nsh suite passed: 862/862 tests, 0 failures. A manager attempt timed out before completion; the complete rerun used the existing pinned tooling.
- Browser verification: coder reproduced the original overflow and prompt displacement in Chrome, then checked real panel rendering at 390px and 1280px in sheet and workbench layouts. Short, long, unbroken and multiline values stayed within the panel; prompt aligned with first line; clipboard copied a path without the marker. Screenshots and probe retained as run artifacts outside the repository.
- Not checked: native Android and native desktop applications; no device/emulator available. Existing browser line-breaking behavior after double hyphens remains.
- Push initially required repository-path credentials; retried successfully using command-local credential.useHttpPath=true. No persistent credential settings changed.
Moved new/ → review/ for independent review.
## factory · review · 2026-11-13 11:08
head: 1d0647c92f958da9a33cc1cc5e29e112527e36b7
verdict: pass
notes:
- Claude Code independently reviewed every hunk in all eight changed files against origin/master and the request/plan; no qualifying P0/P1/P2/P3 findings. Branch merges cleanly with origin/master. Worktree clean and head unchanged after review.
- Validation with a throwaway HOME: configured gofmt/vet/full Go test gate passed; nsh check passed; full nsh suite passed (897 tests, zero failures), including 11 activity-parameter tests.
- Chrome/Playwright fixture checks at widths 360, 760 and 1400 confirmed constrained wrapping, prompt alignment, preserved multiline content and highlighting, and no page errors. Path-copy payload confirmed by intercepting clipboard.writeText; OS clipboard read-back unavailable for file URLs.
- Installs: none. Existing pinned nsh tooling, Playwright and system Chrome reused.
- Residual checks: native desktop and Android rendering/copy behavior were not exercised. Owner should check those native hosts before shipping if native-specific assurance is required.
- Moved review/ → ready/; not merged or shipped.
