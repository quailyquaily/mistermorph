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
