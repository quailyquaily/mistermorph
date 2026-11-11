# Restore bottom navigation on the mobile new-topic page

## factory · 2026-11-11 13:13
Recorded from the owner’s UI fix request.

Request:
> The new topic page, does not show the bottom nav on mobile view.

Interpretation: the missing bottom navigation is the reported bug; show it on the mobile new-topic page, consistently with other mobile views.

Acceptance criteria:
- Inspect the new-topic route and mobile layout to identify why the bottom navigation is missing.
- Show the standard mobile bottom navigation on the new-topic page, preserving active state and navigation behavior.
- Keep the form and actions usable above the navigation, including safe-area insets and virtual-keyboard behavior; avoid overlap and duplicate navigation.
- Preserve desktop layout and existing topic creation behavior.
- Add regression coverage and check narrow mobile web and Android app layouts. Explicitly record any platform or keyboard behavior not actually checked.

Implementation: Claude Code only; do not use Codex.
