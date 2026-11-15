---
branch: factory/FT122-blurred-glass-composer-topbars-bottom-nav
round: 1
---
# Blurred-glass surfaces for composer, page topbars, and bottom navigation

## factory · 2026-11-15 08:49
Owner request:
> Some panels I hope they can be blurred glass:
> Composer's input; all page topbar above a scrolling area(typically all page topbar on mobile, most column 2 topbar on desktop); bottom nav.

Acceptance criteria:
- Give the composer's input surface a translucent blurred-glass treatment.
- Apply the same treatment to every page topbar above a scrolling area: typically all page topbars on mobile and most column 2 topbars on desktop. Audit the actual scroll containers rather than applying the effect indiscriminately to unrelated panels.
- Give the mobile bottom navigation the same blurred-glass treatment.
- Blur the content behind these surfaces, not the text, icons, or controls within them; use consistent translucency, blur, and subtle borders that fit the existing theme.
- Keep text, placeholders, icons, focus indicators, and selected states readable in supported themes, including when busy content scrolls behind the glass.
- Preserve existing positioning, scrolling, input behavior, navigation, touch targets, and mobile safe-area spacing. Avoid introducing nested scrolling or layout shifts.
- Provide a readable fallback where backdrop blur is unsupported or reduced transparency is requested; avoid excessive blur layers that harm scrolling performance.
- Check the composer, representative mobile page topbars, desktop column 2 topbars, and mobile bottom navigation with content scrolling behind them; add relevant regression coverage.

## factory · plan · 2026-11-15 09:20

Behaviour:
- Composer input frame, page headers actually overlaying scroll content (mobile page headers and desktop column-two headers), and mobile navigation share translucent backgrounds and backdrop blur; text and controls remain opaque.
- Audit scroll containers and stacking first; content must actually be able to appear behind treated surfaces rather than an opaque wrapper. Empty/first-run pages, errors, placeholders and selected/focused states remain readable.
- Unsupported blur and reduced transparency use opaque themed surfaces. Preserve keyboard, safe areas, geometry and interactions.

Scope:
- Console presentation and regression tests: ChatComposer/composerField, MobileBottomNav (already blur(20px), bg-card/85), shared/page-specific headers and scroll boundaries.
- No popup redesign (FT123), backend change, new dependency by default, or unrelated refactor.

Decisions:
- Reuse theme tokens and existing navigation's restrained glass appearance; share only the small policy/treatment needed for consistency.
- Document capability limitations honestly; no ancestor opacity or redundant nested blur layers.

Checking:
- Regression tests for shared glass/fallback/reduced-transparency policy and composer, representative mobile/desktop headers and navigation; preserve safe areas and layout.
- Run nsh check, Console scripts/test.sh, and configured gofmt/vet/Go tests using a throwaway absolute HOME.
- Inspect rendered scrolling if possible; explicitly record visual/device coverage not performed.

## factory · 2026-11-15 09:51
Built on `factory/FT122-blurred-glass-composer-topbars-bottom-nav`, head: 6a8d3373. Round 1.

- Shared 78% themed tint and 20pt backdrop blur on the composer, mobile navigation and audited page bars over scrolling content. Scrollers extend behind bars without moving first rows; no-blur layout remains unchanged. Landing composer stays opaque.
- Audited Topics/conversation, Contacts, TODO, Memories, Skills/store, Settings, Audit, Usage and Context; excluded unrelated cards, sidebar, workbench and Logs toolbar/table header.
- Browser capability detection and live reduced-transparency preference provide opaque fallback. Android API 31+ and iOS use blur; desktop renderer and older Android use opaque surfaces. Native reduced-transparency settings are not exposed by nsh.
- Adjusted scroll-to-file, Contacts keyboard walk and Settings sticky banner for bar overlap. IndexColumn slot children now evaluate once, preventing a duplicated search/ref regression.
- Installs: none outside repository-pinned dependencies; no manifest or config changes.
- Manager independently verified `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`: PASS. `nsh check`: PASS. Required Console scripts/test.sh: 119 files, 0 failed; chat-attachments passed its isolated retry. Added 13 glass regression tests.
- Coder reports real built Console checked in headless Chrome at mobile 390x844 and desktop 1280x800, with content scrolled behind glass, one/multiline/focused composer and both unsupported/reduced-transparency fallbacks.
- Not checked: Android device/emulator blur and frame cost; desktop native app; iOS/Safari rendering; physical finger scrolling/frame rate. Native reduced-transparency is unsupported by current platform API. Chrome screenshots were 1x due to an independently reproduced headless 2x blur artifact.
- Code branch pushed successfully after enabling repository-path credential lookup for that command. No changes to base or tags.


## factory · review · 2026-11-15 10:26
head: 6a8d3373ef36aa15f396c10fe955af8a15fd0b95
verdict: pass
notes:
- [P2] web/console-nsh/pages/chat/TopicSidebar.tsx:514: underBar extends the drag viewport behind the glass head, but the drop guard still accepts inView >= 0. Exclude the covered barRoom from the drop area and add coverage. Example: desktop 1280x800, food/travel/Untagged groups and 30 untagged topics; scrolling by 185–228pt and dragging Untagged 02 upward 120pt onto the head sends PUT /topics/u02/tags with travel, although that group is hidden. A throwaway probe reproduced this only with glass enabled.
- [P3] web/console-nsh/pages/chat/ChatPage.tsx:241: the mobile glass container pulls the loading skeleton up 57pt, but only the loaded List receives topInset. Apply the pull only after loading or inset the skeleton. Example: history loading beyond the 160ms skeleton delay places the first bubble at y=20–58 under the 57pt bar (code trace, not rendered).
- [P3] web/console-nsh/components/knowledge/parts.tsx:296: BarRoom is outside the content-layout measurement, hiding the initial end fade when overflow is smaller than the bar room; TodoIndex and Settings share this shape. Include BarRoom in the measurement. Example: Settings index with 500pt visible list, 560pt rows and 103pt room evaluates 603 < 559 as false despite 60pt hidden (code trace, not rendered).

Reviewed by Claude Code against origin/master (137458ce), all 25 changed files. No P0/P1 findings; moved review/ → ready/ under factory policy. P2/P3 notes remain for owner consideration.

Validation (coder run, throwaway absolute HOME and TMPDIR):
- Configured gofmt/vet/Go test command: PASS, 163 packages ok.
- nsh check: PASS.
- Required Console scripts/test.sh: PASS, 119 files, 0 failed; no isolated retries needed.
- Installs outside pinned dependencies reported: TypeScript 7.0.2 fetched by nsh check into throwaway HOME cache; no manifest changes.
- Worktree verified clean at reviewed head; no code commits made. Branch merges cleanly with fetched master.
- Visual browser inspection could not be completed: local headless page did not finish loading. Blur/tint/readability not independently visually checked. Android/iOS, native desktop and scrolling frame rate not checked. Focus traversal under the bar and scrollbar-thumb visibility remain unconfirmed, not findings.


## factory · 2026-11-15 13:02
Shipped to master with Claude Code. Merge commit: c35c40876c5bfcaf5a2bb6355c7f05801e370c6d. Final tested and pushed head: 239920e552855bfff298c2580f914ed5d7cd17ed. No tag created or pushed, per owner instruction.
Final validation: gofmt cleanliness, go vet ./... and go test ./... passed (163 packages); nsh check passed; required Console scripts/test.sh passed (122 files, 1065 tests, zero failures after chat-attachments isolated retry); extra Node tests 274/274. No unpinned installs.
Integration conflicts resolved preserving both feature intents: web/console-nsh/components/knowledge/parts.tsx, web/console-nsh/components/todo/TodoIndex.tsx, web/console-nsh/components/ui.tsx, web/console-nsh/pages/audit/AuditPage.tsx, web/console-nsh/pages/contacts/ContactsPage.tsx, web/console-nsh/pages/todo/TodoPage.tsx, web/console-nsh/tests/harness.ts.
Existing review P2/P3 notes remain unchanged. Combined glass/scroll-memory and popup UI not visually checked; no browser/device or platform build performed during ship. No linked GitHub issues or PRs to close. Branch retained (clean action not configured). Moved ready/ → done/.
