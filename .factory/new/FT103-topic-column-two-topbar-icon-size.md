# Match topic column-two topbar icons to regular icon buttons

## factory · 2026-11-13 00:42
Owner request:
> It seems the size of icon on the topic page column 2 topbar is smaller than a regular icon buttons icon? If so make it larger to meet the size.

### Expected behavior
- Inspect the current topic page's second-column topbar and compare its icon glyph dimensions with the standard icon-button component at the same viewport and scale.
- If smaller, increase the affected topbar icons to the regular icon-button icon size, preferably using the existing shared sizing token or component rather than a new arbitrary size.
- Preserve button hit areas, alignment, spacing, tooltips, accessibility labels, and click behavior. Do not enlarge button containers unless required to match the existing standard.
- Keep desktop and mobile layouts free of clipping or overflow; do not change intentionally smaller indicators or carets.

### Acceptance checks
- Verify computed icon dimensions against regular icon buttons and visually compare the second-column topic topbar at desktop and narrow/mobile widths.
- Add regression coverage for the sizing rule where practical; run the configured repository and Console checks/tests.
- If the icons already match, record the measured comparison instead of enlarging them unnecessarily.
- Explicitly report if visual verification is unavailable.

Scope: topic page second-column topbar icon sizing only. The suspected size mismatch has not yet been confirmed against the current UI.
