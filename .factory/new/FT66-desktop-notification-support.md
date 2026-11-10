# Support notifications on the desktop version

## factory · 2026-11-10 11:15
Owner request:
> new feature request:
> the notification feature should implement on desktop version as well.

Implement the existing notification feature on the desktop version as well. Inspect the current notification implementation and desktop runtime first; reuse existing notification events and preferences rather than introducing a separate notification policy.

Acceptance criteria:
- Desktop users receive notifications for the same applicable events supported by the existing notification feature.
- Use the notification mechanism supported by the desktop runtime and handle permission requests, denial, and unavailable notification support gracefully.
- Preserve existing notification preferences and avoid duplicate notifications for the same event.
- Preserve notification navigation to the relevant topic where supported by the existing feature.
- Add regression coverage for desktop notification delivery, permission/unsupported cases, and duplicate prevention; document any platform behavior that cannot be verified locally.

Registered only; implementation and platform verification have not started.
