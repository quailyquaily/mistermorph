# Support voice input in the Android app

## factory · 2026-11-10 00:40
Owner request: "new feature: Android app should support voice input."
Requested status: new/.

Acceptance criteria:
- Implement working voice input in the native Android app, not merely the mobile browser. Inspect the actual Android host architecture rather than assuming it uses a WebView.
- Reuse the composer microphone icon and existing transcription route/workflow where applicable. With recording capability and the applicable transcription route ready, let the user record, stop, transcribe, and insert editable text into the current draft without automatically sending it or losing existing draft text.
- Implement Android microphone permission handling, including first use, denial, permanent denial, and retry; provide clear actionable errors without reporting an unavailable recorder as ready.
- Support cancellation and recover cleanly from recording/upload/transcription failures. Release microphone resources and remove temporary recordings on completion, cancellation, and failure.
- Stop or cancel recording safely when the app leaves the foreground or the user changes the relevant conversation; prevent stale results from modifying another conversation's draft. Do not record in the background.
- Preserve existing browser and Linux desktop voice input behavior and current route-readiness checks. Keyboard-provided dictation is not a substitute for this feature.
- Add focused regression coverage for the Android host bridge, permissions, lifecycle cleanup, readiness and draft insertion as practical. Run repository and affected Android build/test checks; verify microphone capture and transcription on a real Android device when available, and explicitly record any unperformed device, microphone, or UI checks. Automated tests alone must not be reported as real-device verification.

Scope: Android app recording and integration with existing composer/transcription behavior; no unrelated platform expansion or redesign.

Registered only; not implemented or device-verified.
