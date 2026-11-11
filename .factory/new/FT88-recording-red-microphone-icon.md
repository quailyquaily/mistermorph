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
