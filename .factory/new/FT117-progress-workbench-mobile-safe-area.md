# Match Progress workbench safe-area background on mobile web and Android

## factory · 2026-11-14 08:03
Owner request: "the progress workbench panel needs a safe area with the same background color on mobile web and Android."

Requirements:
- Respect device safe-area insets in the Progress workbench panel on mobile web and Android, including the bottom gesture/navigation area and any relevant top or side insets.
- Extend the panel's background color through its safe area so there is no contrasting strip or exposed page background at the screen edge. Use the panel's current theme color rather than a hard-coded color.
- Keep panel content, scrolling, and controls clear of system UI; do not add duplicate inset padding when an outer container already handles it.
- Preserve desktop layout and zero-inset mobile behavior.

Acceptance checks:
- On mobile web with nonzero safe-area insets, the open Progress workbench has a continuous matching background and no obscured controls or output.
- Verify the same behavior in Android, including edge-to-edge/gesture navigation; check portrait and landscape where insets change.
- Check supported light/dark themes and panel open/close behavior. No extra blank strip or doubled padding on zero-inset devices or desktop.

Scope: Progress workbench panel safe-area layout and background; no unrelated panel redesign.
