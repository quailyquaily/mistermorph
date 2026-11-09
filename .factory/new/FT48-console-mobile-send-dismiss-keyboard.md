# Dismiss the mobile keyboard when sending a chat message

## factory · 2026-11-10 00:31
Owner request (mobile views): "Click the send button, the keyboard should close."
Requested status: new/.

Acceptance criteria:
- On mobile, tapping an enabled Send button dismisses the software keyboard while preserving the existing send behavior.
- Do not lose or duplicate messages; preserve current validation, disabled-send and failed-send draft behavior.
- Verify keyboard-visible and keyboard-hidden cases; keep desktop behavior unchanged.
- Add focused regression coverage where practical; record any mobile/device checks that could not be performed.

Registered only; not diagnosed, implemented, or visually verified.
