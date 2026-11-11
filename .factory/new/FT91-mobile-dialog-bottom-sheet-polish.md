# Fix mobile bottom-sheet safe areas, action widths, and transitions

## factory · 2026-11-11 13:31
Recorded from the owner's UI fix request.

Request:
> All dialogs, if them popup as a bottom sheets on mobile view, the safearea should be filled with the background color. If there are only 2 action buttons on the bottom of the dialog, make them the same width. And because they act as bottom sheets, so the transition should go from bottom to slide in, and slide out to the bottom.

Acceptance criteria:
- Audit all dialogs rendered as bottom sheets at mobile widths; apply consistent behavior through shared components/styles where possible.
- Fill the bottom safe-area inset with the sheet background color, with no transparent or mismatched strip; keep actions clear of system navigation and avoid double insets.
- When the bottom action row contains exactly two buttons, give both equal width. Preserve other action counts and desktop dialog layouts.
- Sheets slide in from the bottom on opening and slide out toward the bottom on closing. Keep the sheet mounted until its exit animation finishes; respect reduced-motion preferences.
- Preserve scrolling, keyboard/safe-area layout, dismissal, focus handling, and touch interaction.
- Add regression coverage for safe-area background, two-action sizing, and enter/exit states. Verify mobile web and Android app, plus desktop non-regression; explicitly record any platform not actually checked.

Implementation: Claude Code only; do not use Codex.
