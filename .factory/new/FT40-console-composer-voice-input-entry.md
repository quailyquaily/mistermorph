# Restore the composer voice-input icon button when the model route is ready

## factory · 2026-11-09 07:04
Owner report: there is no voice-input entry in the composer even though the model route is ready. The voice-input button should be an icon button. Requested status: new/.

Acceptance criteria:
- Investigate why the voice-input entry is missing with a ready, applicable model route and make it available in that state.
- Render the voice-input entry as an icon button consistent with the other composer controls, with an accessible label and appropriate touch target.
- Preserve the existing voice-input workflow, permission handling, and unavailable/error states; do not show a ready action when its required route is unavailable.
- Add regression coverage for ready versus unavailable routes and check the composer on mobile and desktop. Record any visual or device checks that cannot be performed.

Scope: composer voice-input entry visibility and icon-button presentation; no cause is assumed.

Registered only; not diagnosed, implemented, or visually verified.
