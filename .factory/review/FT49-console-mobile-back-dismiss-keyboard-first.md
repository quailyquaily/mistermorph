---
branch: factory/FT49-console-mobile-back-dismiss-keyboard-first
round: 1
---
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

## factory · plan · 2026-11-10 01:36
Behaviour: In mobile chat, Back first dismisses an open software keyboard without changing topic or draft. With the keyboard closed, Back returns to the topic list as before, including empty/read-only and first-run states. Desktop behavior stays unchanged.
Scope: Wire the chat back arrow through a minimal keyboard-dismissal helper and composer focus tracking; add focused regression coverage. Leave Android system Back and unrelated navigation unchanged.
Decisions: Use nsh Keyboard and keyboardFrame rather than DOM-specific handling or dependencies. Prefer reported keyboard geometry; use focus as fallback before frame reporting is observed. Do not restore focus after dismissal.
Checking: Cover open and closed keyboard, retained draft, no refocus, repeated taps, and narrow desktop. Run repository Go checks and Console type/tests. Record unavailable physical-device checks.

## factory · 2026-11-10 01:36
Built a3b8e911: mobile chat back arrow dismisses the software keyboard before leaving; composer reports focus, with a small keyboard-state helper and regression coverage. Moved new/ → review/.
Decisions: A positive keyboard frame continues consuming Back during dismissal animation. After a frame has reported a keyboard once, frame geometry controls visibility. Before any reported frame, focused composer is the fallback. Android system Back remains unchanged.
Known limitation for review: on a phone using a hardware keyboard before any software-keyboard frame has been reported, the first Back tap with the composer focused unfocuses it; a second tap navigates.
Installs: none.
Tests: gofmt check, go vet ./..., go test ./... passed (manager independently reran). Claude Code reports nsh check passed and all 349 Console tests passed, including a regression that fails with the arrow change removed.
Not checked: physical-device or visual UI behavior, Android/iOS keyboard animation, mobile-browser viewport reporting, and hardware-keyboard behavior. No Android SDK/emulator was available.
