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
