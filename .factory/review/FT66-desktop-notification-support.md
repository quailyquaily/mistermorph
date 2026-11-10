---
branch: factory/FT66-desktop-notification-support
round: 1
---
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

## factory · plan · 2026-11-10 16:12
Behaviour: Deliver existing system and task-completion notification events through the desktop native host. Preserve foreground and cron suppression, stored preferences, event deduplication and topic navigation. Handle first-run permission, denial and unavailable service without duplicate native attempts.

Scope: Repair gaps in the existing notify-rust bridge and shared Console notification path; no second policy or backend stream. Inspect platform adapters, native host and notification settings.

Decisions: Reuse actual host capabilities; avoid claiming OS permission state when it cannot be queried. Keep browser and Android behavior. Preserve navigation where the native runtime supports activation callbacks.

Checking: Delivery, permission/unsupported states, duplicate attempts, foreground/cron suppression and topic navigation regressions; required Go checks, nsh check and full nsh tests; native Rust checks where available. Record native platform/manual UI limitations.

## factory · 2026-11-10 16:12
Built in commits 7e249fb3 and faf3604f; moved new/ → review/ (round 1).

Linux probes the session notification service off the engine thread, reporting unsupported when absent. Windows toast body activation forwards the notification ID. Shared Console delivery now makes one attempt only after granted permission, with unavailable-service messaging in settings and TODO. Existing preferences and suppression are retained.

Tests: manager independently passed gofmt cleanliness, go vet ./... and go test ./... in a throwaway HOME. Claude Code reports nsh check passed; nsh tests 416 passed, 0 failed; cargo test --offline 66 passed, 0 failed, 4 ignored. Private Linux session-bus tests verified absent-service behavior and fake-service delivery/Open-action navigation. No installs.

Not checked: real desktop popup/window UI (no display or running notification service). Windows and macOS were not compiled or run; both retain assumed granted permission because the bridge cannot query OS-level disabling. Windows Action Center activation remains unverified; macOS activation brings the app forward without topic routing. Platform limitations documented in desktop/nsh/README.md.

Initial branch push required command-local credential.useHttpPath=true; retry succeeded. No base branch or tags pushed.
