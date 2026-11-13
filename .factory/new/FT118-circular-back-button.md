# Make the back button circular

## factory · 2026-11-14 08:05
Owner request: "The back button should be circle button too. Put to new/"

Requirements:
- Make the Console back button circular, consistent with the other circular icon buttons, including the Progress workbench navigation where present.
- Use equal width and height and center the back icon; preserve a usable touch target on mobile web and Android.
- Retain existing navigation behavior, accessible labeling, keyboard focus, and hover/pressed states.
- Match existing theme colors and icon-button styling rather than introducing a separate visual style.

Acceptance checks:
- The back button is visibly circular, not square, rectangular, or pill-shaped, on desktop, mobile web, and Android.
- The icon remains centered, and the button does not stretch or clip at narrow widths.
- Back navigation and keyboard interaction continue to work; verify supported light/dark themes.

Scope: Back-button appearance and sizing; no navigation behavior changes.
