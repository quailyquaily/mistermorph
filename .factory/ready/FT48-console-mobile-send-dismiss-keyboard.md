---
branch: factory/FT48-console-mobile-send-dismiss-keyboard
round: 1
---
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

## factory · plan · 2026-11-10 01:03
Behaviour: An enabled mobile Send dismisses the keyboard synchronously and calls the existing submission once. Disabled/busy Send does nothing; Stop and desktop/keyboard submission retain current behavior. Empty and failed sends retain existing validation and draft ownership; dismissing an already hidden keyboard is harmless.
Scope: ChatComposer Send handler and regression coverage only; no navigation or other mobile changes.
Decisions: Reuse !platform.desktop and Keyboard.dismiss rather than introducing blur/refocus logic. Parent focus restoration is desktop-only.
Checking: Cover mobile visible/hidden keyboard, disabled/empty, success/failure drafts, Stop and desktop focus. Run Go formatting/vet/tests and nsh check/full suite; record unavailable device checks.

## factory · 2026-11-10 01:03
Built and pushed 72d42e47 (feat(console-nsh): Send lowers the keyboard on phones).
Mobile Send dismisses the keyboard before submitting once; Stop and desktop behavior are unchanged. Added focused success/failure, disabled, already-hidden and desktop coverage, and updated the existing sheet test to refocus after sending.
Installs: none.
Manager verification: gofmt check, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js all passed (348/348 nsh tests). Scripted tests used a throwaway absolute HOME.
Not checked: actual Android/iOS keyboards, mobile browsers or desktop app visually; no real device/emulator/display was available. Headless tests verify focus behavior only.
Coder reported writing a build-tooling memory note outside the requested worktree; this was not part of the code commit and was not independently inspected.
Moved new/ → review/ for review; not merged.

## factory · review · 2026-11-10 01:20
head: 72d42e47da16341a6c7eb203a79cb9afbb5ef75d
verdict: pass
notes:
- [P2] web/console-nsh/components/chat/ChatComposer.tsx:462: On wide mobile screens, post-submit focus restoration undoes Keyboard.dismiss because the parent uses width >980 rather than platform.desktop. Codex reproduced Android 1280x800: send "hello", receive HTTP 500, then typing "!" changes the preserved draft to "hello!" without refocusing; exactly one request was sent. Gate post-send focus restoration on desktop platform while preserving Stop and desktop behavior.
- Required validation passed: gofmt check, go vet ./..., go test ./... (162 packages passed, 19 without tests), nsh check, and nsh test --web-host tests/noHost.js (348 passed). The supplemental wide-Android reproduction failed as expected for the P2 above; it is not a failure of the configured mandatory suite.
- No P0/P1 findings; moved review/ → ready/ under the factory review threshold. Owner should inspect the wide-mobile focus issue before shipping.
- Installs: none. Scripted tests used a throwaway absolute HOME. Real Android/iOS keyboards were not available; only headless focus behavior was verified.

## factory · 2026-11-10 07:47
Held out of v0.3.91: owner authorized shipping items if there are no problems; the concrete unresolved findings in the latest review remain. Left in ready/ without merging. No fixes attempted during this ship run.
