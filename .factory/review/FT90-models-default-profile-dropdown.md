---
branch: factory/FT90-models-default-profile-dropdown
round: 1
---
# Fix the default-profile dropdown in Settings → Models

## factory · 2026-11-11 13:31
Recorded from the owner's UI fix request.

Request:
> The settings -> models, the default profile top right drop-down, cannot popup.

Acceptance criteria:
- Reproduce and fix the top-right default-profile dropdown failing to open in Settings → Models.
- The menu opens by pointer, touch, and keyboard, remains visible above surrounding UI, and allows selecting and saving the default profile.
- Preserve current selection, dismissal, focus handling, and existing settings behavior.
- Add regression coverage for opening and selecting; verify desktop web, mobile web, and Android app behavior, explicitly recording any platform not actually checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 17:30
Behaviour: Open the Models top-right menu by pointer, touch or keyboard; choosing an action opens its settings and saving preserves the default model. Dismissal, loading/disabled and empty-profile cases keep existing behavior.
Scope: Repair consumed trigger events in shared menu triggers and the Models menu; cover the identical Channels trigger defect. No backend changes or redesign.
Decisions: The Models top-right control is the ellipsis action menu, not a profile picker. Keep profile selection and persistence unchanged.
Checking: Trigger opening/selection/dismissal/disabled tests; settings save regression; Go formatting, vet and tests; nsh check and full nsh tests. Check desktop/mobile web where available and distinguish Android simulation from real-device verification.

## factory · 2026-11-11 17:30
Built and pushed ddb84d765715d5b4f8b2ddf98e0097c342f27a35. Recovered the clean worktree and existing completed commit from a stopped build; Claude Code inspected it and verified it without unnecessary additional commits.
The nested Button consumed activation before the menu could receive it. A plain MenuIconTrigger preserves its appearance and tooltip; Models and Channels use it with disabled state on the menu. Added trigger and settings regression tests and documented the trap.
Tests: manager independently passed gofmt cleanliness, go vet ./..., go test ./.... Claude Code passed nsh check and all 631 nsh tests (10 new). Scripted tests used absolute throwaway HOME directories.
UI: Claude Code verified desktop Chrome click/open/overlay/dismiss/select/save/reopen, mobile-width Chrome touch emulation and keyboard Enter/Space opening, Escape dismissal and restored focus. Original trigger reproduced failure.
Outstanding limitation for review: keyboard arrow navigation and Tab do not reach menu items, so keyboard-only selection remains unavailable; coder identified this as shared nsh menu behavior and did not change it. This is not full keyboard acceptance.
Not checked: physical Android or emulator (only simulated nsh Android tests), desktop app, real mobile browser, live disabled/loading appearance. Profile-picker behavior was preserved rather than changed.
Installs: none. Initial branch push failed because the credential helper lacked a repository path; retry with command-local credential.useHttpPath=true succeeded.
Moved new/ → review/ for review, including the keyboard limitation.
