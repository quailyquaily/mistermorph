# Mobile bottom navigation items must not overlap

## factory · 2026-11-10 00:41
Owner request: "New UI fix: mobile view bottom nav's items, do not overlay."

Fix the mobile bottom navigation layout so its items do not overlap each other. Keep icons, labels, and touch targets distinct and usable at narrow mobile widths, in both the mobile browser and Android app.

Acceptance criteria:
- Navigation items have separate, non-overlapping bounds; icons and labels do not collide or obscure adjacent items.
- All navigation destinations remain visible and tappable, including the active item; do not solve the problem by hiding destinations.
- Respect bottom safe-area insets and preserve existing navigation behavior and desktop layout.
- Check narrow mobile widths (including 320px and 360px), portrait/landscape, and increased text size. Add regression coverage for the layout where supported.
- Report visual checks performed and explicitly identify any Android-device checks not performed.

Queued UI fix only; not implemented yet.
