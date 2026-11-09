# Align single-line composer text with adjacent controls

## factory · 2026-11-09 19:10
Owner request: "2. When the composer in single line mode, the text of the inputbox should be aligned with other components(buttons, drop-down, etc)"

Queue this UI fix in new/.

Acceptance criteria:
- In single-line mode, vertically center the input text and placeholder on the same visual centerline as adjacent buttons and dropdown controls.
- Keep alignment consistent on mobile and desktop, including focus and empty/populated states, without clipping text or shrinking control hit targets.
- Preserve multiline growth, wrapping, scrolling, send behavior, and keyboard interactions; do not impose single-line alignment rules on multiline content.
- Prefer correcting shared layout/line-height/padding rules over device-specific offsets.
- Add regression coverage and visually check empty and populated single-line input alongside controls, plus the transition to multiline. Record any checks that cannot be performed.
