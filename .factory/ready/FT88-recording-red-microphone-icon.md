---
branch: factory/FT88-recording-red-microphone-icon
round: 1
---
# Use a red microphone icon while voice input is recording

## factory · 2026-11-11 13:13
Recorded from the owner’s UI fix request.

Request:
> The voice input icon button, when recording, use a red mic phone icon instead of the stop icon.

Acceptance criteria:
- While voice input is actively recording, show a red microphone icon instead of the stop icon.
- Preserve the existing button action for ending recording; this request changes the visual indicator, not the recording workflow.
- Keep the accessible label appropriate to the current action (stop recording while active), and preserve focus and disabled states.
- Restore the normal non-recording icon/color when recording ends, is cancelled, or fails; do not show active recording during permission failure.
- Add regression coverage for recording state transitions and verify web and Android rendering. Explicitly record any platform not actually checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 15:53
Behaviour: Idle and first run keep the normal microphone. Active recording shows a red microphone with the existing stop action and accessible label. Transcription retains its busy appearance. End, cancellation and failure restore the non-recording indicator; permission denial never shows recording.
Scope: Voice control appearance and regression coverage only; no recording workflow or send-stop control changes.
Decisions: Use PhMicrophone and the existing danger token in the shared web/Android component, preserving selected, disabled and focus states.
Checking: Cover idle, recording, transcription, cancellation, permission and recorder failures; run Go checks and nsh check/tests. Check web rendering and explicitly report Android visual limitations.

## factory · 2026-11-11 15:53
Built with Claude Code in ce066a71. Recording now displays a danger-red microphone; stop action and accessible labels remain unchanged. Added optional Icon testID forwarding and voice-state regression tests, including Android-host cases and a browser fixture.
Tests: Manager independently passed gofmt cleanliness, go vet ./..., go test ./..., and git diff --check. Coder reported nsh check passed and full nsh suite 626 passed, 0 failed.
Installs: None.
Visual checks: Coder checked the web view in headless Chrome. Android was covered by headless tests only, not visually checked on a device or emulator. Desktop app was not visually checked.
Branch pushed; moved to review/ for independent review.

## factory · review · 2026-11-11 16:18
head: ce066a7104d8e3866abfc549fba18a8f41496574
verdict: pass
notes:
- Claude Code independently reviewed all six changed files against origin/master (7a63c01ab829d9dd3b0946b380153166e6c89906); no actionable introduced defects found.
- Validation passed: gofmt cleanliness, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js (626 passed, 0 failed). Tests used a throwaway HOME. No installs; worktree unchanged.
- Visual limits: review used headless web/Android tests; actual icon colour was not visually checked in a browser, Android device/emulator, or desktop app. Android visual verification remains outstanding.
- Existing behaviour, not introduced here: recording state begins while microphone permission is pending; denial restores idle. Delayed permission responses are not covered by the new immediate-response hosts.
- Moved to ready/; not merged or released.
