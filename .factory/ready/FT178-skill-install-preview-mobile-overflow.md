---
branch: factory/FT178-skill-install-preview-mobile-overflow
round: 1
---
# Keep the skill install preview card's long values inside it on phones

## factory · 2026-11-24 15:51
Owner request: “on mobile view, the output panel of the skill preview, the content may overflow the panel. please check if this issue exists or not.” → checked, confirmed → “add to factory new/”

The skill install approval card in chat (`components/chat/ChatSkillInstallPreview.tsx`, the "Approval required" card of a `skill_install` call) lets long values run past its right border on a phone. Checked on the web Console built from master (a92d51f4), 390×844, with a real GitHub skill (anthropics/skills, `skills/pdf`) and review findings with long values. Card's right edge at x=351:

- **Source** row (`:143`, link + `@commit`): ran to x=700. A GitHub source URL carries the full 40-character commit (`…/tree/<commit>/skills/pdf`), so this happens on nearly every GitHub install.
- Finding summary row (`:84`, severity, title, `file:line`): ran to x=565 for a long file path, x=842 for a title with a URL.
- Note row (`:266`, title, file, evidence): ran to x=1007 for a long evidence string.
- Coverage gaps row (`:209`, path, status, note) uses the same pattern; not triggered in the check, likely the same.

The page itself did not scroll sideways (document width stayed 390); the content spilled over the card's border.

Likely cause: each of these rows puts several `Text` pieces side by side in a `flex-row flex-wrap` view. On the web a piece wider than the row keeps its whole width instead of wrapping inside it, so `flex-wrap` only moves it to its own line. Text on its own line already wraps correctly in the same card (description, evidence boxes, review summary).

Not affected (checked at 390pt): the Skills page's SKILL.md view and its file preview; long links and lines wrap inside the box, code blocks and tables scroll inside it.

Acceptance criteria:
- At phone widths (360 and 390pt) and in the desktop layout, nothing in the card is drawn past its border: the source URL and commit, finding titles, `file:line`, note titles and evidence, and gap paths wrap inside the card (breaking inside long unbroken runs where needed).
- Short values keep today's look: severity, title and file on one line when they fit.
- The source link stays one pressable link; copying or opening it still gives the whole URL.
- Same behaviour on the desktop app and Android (one TSX source).
- A test covers the long-value cases (long source URL with commit, long file path, long title with a URL, long note evidence, long gap path) and asserts they stay inside the card at a phone width.

## factory · plan · 2026-11-24 16:17
Behaviour: At 360/390pt and desktop widths, wrap long source URLs/commits, finding titles/file locations, note titles/files/evidence, and coverage gaps inside the card. Preserve compact short rows, full link targets, folds, empty/error/expired states.

Scope: The shared ChatSkillInstallPreview component and focused layout tests/fixtures; no renderer, protocol or global style changes.

Decisions: Use nsh-supported min-width/shrink/max-width constraints, not clipping, truncation or changed text. Bound fold summaries and parameter value columns. Keep one pressable source link. Follow the repository's nsh 0.6.0 version.

Checking: Real layout assertions at 360, 390 and desktop widths for all long-value cases, short inline rows, full link activation, folds and empty/expired states; nsh check, the required parallel Console test runner, gofmt/vet/Go tests; browser fixture measurements where available.

## factory · 2026-11-24 16:17
Built and pushed commit 7d5e01cf on factory/FT178-skill-install-preview-mobile-overflow (round 1).

Long inline texts can shrink and wrap within the card; fold buttons and parameter value columns are constrained. Fold carets align with the first line of a wrapped summary. The original source URL and commit remain unchanged. Added 8 layout regression tests and focused fixtures with opt-in layout probes following existing repository patterns.

Tests: gofmt, go vet ./..., go test ./... and nsh check pass; independently rerun by the manager. The coder ran scripts/test.sh: 165 files, 0 failed after the runner's isolated retries of chat-topics-older and chat-waiting-answer. Manager independently reran the new 8 layout tests: all pass. Coder removed the fix classes experimentally: 6 long-value tests failed as expected.

UI checked: coder built and measured the real approval-card fixture in Chrome at 360, 390 and 1280 widths; no text spills after the fix, no sideways page scroll, and clicking opens the complete URL. Screenshots inspected by the coder. Not checked: a physical Android device, native desktop runtime, and the real backend-served Console; headless Android layout at 360 passed.

Installs: none; no manifest or lockfile changes. No newly observed /tmp entries. Coder reported an out-of-scope write to its own tooling-memory note and index outside the factory directory; these are not included in the code commit. The code branch contains only this item's four files and no forbidden-path changes. Initial push credential-helper failure was resolved on the single retry using command-local credential.useHttpPath=true.

## factory · review · 2026-11-24 16:25
head: 7d5e01cfe08d4b2c4c4015f890b5ddff256e38e1
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD (base a9421ae8), all four changed files and the surrounding approval-card integration. No findings.
- Required gofmt/vet/Go tests pass (168 packages ok, 20 with no tests). nsh check passes. Required parallel Console runner passes: 165 files, 0 failed after its isolated retries of chat-voice, dialog-sheet, settings-page-sections and settings-page.
- All 8 focused headless layout tests pass independently at phone and desktop widths. Removing the fix classes in a temporary copy makes 6 of 8 fail, confirming regression coverage.
- Review did not repeat browser measurements; physical Android, native desktop and Android JVM tests were not checked. Headless Android-platform layout was checked at 360pt.
- Installs: none. Worktree unchanged; no code commits. Coder reported harness task output outside the run directory under /tmp/claude-995; recorded for owner-confirmed cleanup, not deleted.
