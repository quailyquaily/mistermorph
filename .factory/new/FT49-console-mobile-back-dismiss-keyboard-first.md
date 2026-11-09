# Dismiss the mobile chat keyboard before navigating back

## factory · 2026-11-10 00:31
Owner request (mobile views): "When clicking the back button at the chat view, if the keyboard is open, it should close before going back to the topic list."
Requested status: new/.

Acceptance criteria:
- When the chat-view Back button is tapped with the software keyboard open, dismiss the keyboard and remain in the current chat. A subsequent tap with the keyboard closed returns to the topic list.
- When the keyboard is already closed, navigate back normally on the first tap.
- Preserve the draft and chat state during keyboard dismissal; avoid unintended navigation or keyboard reopening.
- Add focused regression coverage where practical; record any mobile/device checks that could not be performed.

Registered only; not diagnosed, implemented, or visually verified.
