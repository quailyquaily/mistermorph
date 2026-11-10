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

## factory · review · 2026-11-10 01:46
head: a3b8e91167dd03993270db67b31aadf970eba4fa
verdict: pass
notes:
- [P2] web/console-nsh/lib/softKeyboard.ts:29: With a hardware keyboard from startup, height=0, frameReported=false and fieldFocused=true causes the first Back tap to dismiss focus rather than return to the topic list. Source-level reproduction yields one dismissal and zero navigations, violating the closed-keyboard acceptance criterion. Distinguish reliable zero-height reports from unavailable geometry, and add hardware-keyboard coverage.
- Codex reviewed all six changed files in origin/master...HEAD. No P0/P1 findings; moved review/ → ready/ under the factory review threshold. The P2 remains for owner consideration before shipping.
- Validation: gofmt check, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js passed (349 Console tests, zero failures). git diff --check passed; six source-level state checks performed. Scripted tests used an absolute throwaway HOME. Working tree and head unchanged.
- Installs: none.
- Not checked: physical devices or visual UI, Android/iOS keyboard animation, mobile-browser viewport reporting, actual hardware-keyboard interaction. Hardware-keyboard finding reproduced at source-state level only.

## factory · 2026-11-10 07:47
Held out of v0.3.91: owner authorized shipping items if there are no problems; the concrete unresolved findings in the latest review remain. Left in ready/ without merging. No fixes attempted during this ship run.

## claude-code · 2026-11-10 08:29
Owner-requested check and fix of the open review note (local only; not pushed, not merged; item left in ready/).
Confirmed: the [P2] from the 2026-11-10 01:46 review holds at a3b8e911. softKeyboard.ts:29 treats a focused field as an open keyboard whenever no frame was ever reported, so with a hardware keyboard from startup the first Back tap (chatController.ts:1016) only unfocuses. Reproduced headless: on Android with a focused field, the first tap did not reach the topic list.
Fix: local commit d8e0c970 on factory/FT49-console-mobile-back-dismiss-keyboard-first (not pushed). The nsh Android host reads IME geometry from WindowInsets, so on `platform.os === "android"` a zero keyboard frame now means no software keyboard. The focused-field fallback stays only for the web, where visualViewport may not report one. Updated PORTING.md, the integration test (hardware keyboard: first tap goes back, draft kept) and the state table (Android and web cases).
Tests (throwaway absolute HOME): nsh check passed; nsh test --web-host tests/noHost.js 349/349; gofmt check, go vet ./... and go test ./... passed (162 packages ok).
Limitation: headless runs cannot simulate a software-keyboard frame, so the "keyboard up → first tap only lowers it" path is covered by the pure state table only. iOS keeps the web-style fallback (host not verified). Not checked: real devices, hardware keyboards, keyboard animation.

## factory · 2026-11-10 09:08
Owner authorized merging the locally fixed items and tagging/pushing. Merged into master by dd5520e5; release head c89e4e14, tag v0.3.92. Master, tag and the four fixed feature branches pushed.
Combined validation: gofmt/vet and Go tests passed (162 packages); nsh check passed; Console tests 403/403; web Console/backend build passed; Android Java tests 15/15 and manifest tests 3/3 passed. No new installs. FT54 merge resolved by Claude Code, retaining both keyboard and sidebar behavior.
Not verified: real devices, actual keyboard/microphone/permission/lifecycle behavior, visual focus and transitions; no APK built. Previously documented residual limitations remain, including unanswered voice-start waiting and popup registry coverage. No linked issues or PRs to close. Moved ready/ → done/.
