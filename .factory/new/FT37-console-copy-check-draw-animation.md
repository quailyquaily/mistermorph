# Animate the chat copy confirmation check as a drawn stroke

## factory · 2026-11-09 05:44
Requested by the owner: the copy button below the chat bubble should animate its confirmation check icon as though a person is drawing the check, instead of the current zooming-out effect. Add this improvement to new/.

Acceptance criteria:
- After a successful copy, progressively reveal the check stroke in drawing order: the short downward stroke followed by the longer upward stroke.
- Keep the icon at a stable size; replace the zoom/scale effect rather than combining it with the drawing animation.
- Preserve clipboard behavior, confirmation timing/reset, and repeat-copy behavior. Do not show success when copying fails.
- Respect reduced-motion preferences with a static confirmation check.
- Verify the animation on the chat-bubble copy control and add appropriate regression coverage.

Scope: the copy button below chat bubbles; no unrelated button or chat layout changes. Registered only; not implemented or visually verified.
