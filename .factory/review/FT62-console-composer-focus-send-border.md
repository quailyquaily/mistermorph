---
branch: factory/FT62-console-composer-focus-send-border
round: 1
---
# Keep the composer light border visible on focus and after sending

## factory · 2026-11-10 09:03

User request:
> The focused composer also needs the light border, and when click send it has the beam but still doesn't have the beam. I click back and enter the topic again, the light border of composer comes back

Follow-up to FT50. The composer must retain its subtle, design-consistent border while focused and after sending, without requiring the user to leave and reopen the topic.

Acceptance criteria:
- Preserve the light composer border in idle, focused, and post-send states, including mobile keyboard transitions.
- Reproduce the reported sequence: focus the composer, type, send, then compare its border with the appearance after leaving and reopening the topic. Fix inconsistent rendering/state rather than relying on navigation to restore it.
- Keep the existing send and keyboard-dismiss behavior; do not force focus just to restore styling.
- Check mobile and desktop and add regression coverage for focus/send state transitions where practical.

The phrase "has the beam but still doesn't have the beam" is ambiguous; it is preserved above rather than treated as a confirmed caret defect. The actionable reported issue is the missing light border that returns after re-entering the topic.

Registered for implementation; not yet diagnosed or implemented.

## factory · plan · 2026-11-10 12:35

Behaviour: Keep the light composer frame in empty/idle, focused/typing, sending/running, successful reset and error/retained-draft states, through keyboard dismissal and topic reopen on mobile and desktop.

Scope: Composer frame styling and regression coverage only; no send, caret, focus-management or keyboard semantics changes.

Decisions: Preserve mobile line and desktop input border tokens, geometry and existing focus shadow. Investigate the focus border override and animation rather than forcing focus or relying on navigation. The ambiguous beam wording does not establish a caret defect.

Checking: Exercise focus/type/send/running/completion/reopen and send failure; check mobile/desktop rendered border where possible; add regression tests, run configured Go checks, nsh check and the full nsh suite. Explicitly record unavailable device checks.

## factory · 2026-11-10 12:35

Built and pushed 9ef9dc87; new/ → review/, round 1.

Removed the focus-within blue border override and restricted transitions to the shadow. The resting light border remains unchanged; focus still adds its shadow. Added regression assertions preventing state variants from overriding the border and preventing border-color transitions. No protected paths changed; the branch contains one item-specific commit.

The coder measured the pre-change border switching from light to blue on focus in headless Chrome. After the change, phone-sized and desktop-sized browser checks kept the same border through idle, focus, typing, send, running, completion and reopen; a simulated send failure retained its draft and border. The reported persistent post-send defect was not reproduced on a real device.

Tests: manager independently passed gofmt, go vet ./... and go test ./..., plus nsh check. Full nsh suite did NOT pass: initial coder run 403/404 (todo); manager run 403/404 (chat-voice); requested coder retry 402/404 (memories and settings-page-sections). Latest failure: `memories.test.tsx: no pressable view matches id:memories-journal`. The other latest failure could not find id:settings-channel-run-in-console-switch. Targeted chat-voice passed three times; latest two failing files each passed twice alone. Failures appear timing-related and outside changed files, but have NOT been confirmed against base; review must investigate, not assume a clean suite.

Installs: none reported. No Android device/emulator, real mobile keyboard, native desktop app or dark-mode visual check. Browser screenshots/pixel measurements are not native-device verification.
