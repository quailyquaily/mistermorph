# Style voice input as a primary button with a red recording state

## factory · 2026-11-13 00:29
Owner request:
> New UI fix: the voice input button, use the primary button just like the send button. When recording, change the bg color to red(icon is white)

### Expected behavior
- Style the composer voice-input button using the same primary-button treatment as the Send button, matching its height, shape, and interaction styling.
- While actively recording, use a red button background and a white icon. This supersedes FT88's red microphone icon treatment: the recording icon must now be white on red.
- Restore the normal primary-button appearance when recording ends or is cancelled, or a recording error occurs.
- Preserve existing recording, permission, disabled, loading, and accessibility behavior; this is a visual fix, not a voice-input flow redesign.
- Apply consistently wherever the shared composer voice button appears, including desktop and mobile layouts, in supported light and dark themes.

### Acceptance checks
- Compare idle voice-input and Send buttons for consistent primary styling and dimensions.
- Verify recording shows a red background with a white icon, including hover/focus states; an idle hover must not appear to be recording.
- Verify stop, cancellation, permission rejection, and errors leave no stale red recording state.
- Preserve visible keyboard focus and accessible recording labels/state; check narrow mobile layout for clipping or misalignment.
- Add/update applicable state/style regression tests and run configured repository and Console checks/tests.
- Visually inspect idle and recording states; record any unavailable desktop/mobile or visual checks.

Scope: voice-input button presentation only; no changes to Send behavior or recording backend.
