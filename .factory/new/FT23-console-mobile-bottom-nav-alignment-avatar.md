# Fix mobile bottom navigation alignment and avatar styling

## factory · 2026-11-08 11:50
Requested by the owner in Console: add a new Factory request for the mobile view.

Owner's request:
> 1. The bottom nav item padding is wrong. Need to make sure the icon is in the middle.
> 2. The last bottom nav icon, the agent avatar, when click this item, no need to draw a circle on the avatar. Btw, no need to draw a blue square at the avatar as well.

Requirements:
- Fix mobile bottom navigation item padding/alignment so each icon, including the agent avatar in the last item, is centered horizontally and vertically within its navigation item.
- Remove the extra circular decoration drawn over/around the agent avatar when its item is clicked or selected.
- Remove the blue square background/decoration at the avatar. Keep the avatar itself and its intended image shape unchanged.
- Apply the avatar treatment consistently in idle, pressed, and selected states; do not remove accessible keyboard focus indication (use a suitable focus-visible treatment if needed).
- Preserve navigation behavior, accessible labels, touch target sizes, and bottom safe-area handling. Limit styling changes to mobile bottom navigation; do not change desktop navigation unintentionally.

Acceptance checks:
- Inspect narrow mobile widths in supported light/dark themes: all icons sit centrally with balanced padding and no clipping.
- Tap/select the last navigation item: navigation still works, with neither the unwanted circle nor blue square on the avatar.
- Verify keyboard focus remains visible and add regression coverage appropriate to the existing Console test setup.

Request registered only; implementation and visual verification are pending.
