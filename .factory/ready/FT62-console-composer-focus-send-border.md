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

## factory · review · 2026-11-10 12:56
head: 9ef9dc875df5a864c5455dcbbfec59268dc053cf
verdict: pass
notes:
- Codex reviewed both changed files against origin/master (c89e4e143); no introduced defects found. The branch merges cleanly with base. Working tree and head remained unchanged.
- Required Go formatting, vet and tests passed. nsh check passed; HEAD full nsh suite passed 404/404; nsh build passed using the existing nsh 0.4.0 runtime. No installs.
- Base full nsh suite failed 3 contacts tests (400/403): `no pressable view matches id:contact-row:tg:1001; on screen: []`. Codex labeled this a P1 baseline test issue at contacts.test.tsx:67,94,121; these unchanged tests passed 9/9 when run separately on both base and HEAD. This is not an FT62 finding: HEAD required checks passed and the failing run was on base only. No unrelated test fix was made. Previous build failures in todo, chat-voice, memories and settings-page-sections did not recur in either full run; their exact cause remains unconfirmed.
- Codex browser checks covered two widths and eight states per width: the light 1px border remained stable, including retained draft on send failure; baseline focus changed the border to blue.
- Real mobile keyboards, native desktop and dark mode remain unverified. Owner should check the originally reported persistent post-send rendering on a real device.
- review/ → ready/. No linked GitHub issue or PR.
