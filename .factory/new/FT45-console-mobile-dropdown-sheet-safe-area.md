# Mobile dropdown bottom-sheet safe areas

## factory · 2026-11-09 19:10
Owner request: "1. All drop-down, on mobile view, if they show as bottom sheets, the bottom should hold a safe area. For example the composer's plus button and profile selector"

Queue this UI fix in new/.

Acceptance criteria:
- All dropdowns rendered as bottom sheets on mobile reserve bottom safe-area space, including the composer plus menu and profile selector. Audit other dropdown-to-sheet instances, not only these examples.
- Interactive content remains above the home indicator/system gesture area; use the platform safe-area inset rather than a device-specific constant, with normal padding when the inset is zero.
- Apply the rule consistently through shared sheet styling where practical; avoid double-counting existing safe-area padding.
- Preserve scrolling, keyboard-open positioning, dismissal, focus, selection, and desktop dropdown behavior.
- Add regression coverage and visually check mobile sheets with nonzero and zero safe-area insets, keyboard open/closed, and long content. Record any checks that cannot be performed.
