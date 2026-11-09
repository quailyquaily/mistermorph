---
branch: factory/FT52-android-app-voice-input
round: 1
---
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

## factory · plan · 2026-11-10 03:17
Behaviour: Check native recording capability and transcription route readiness. Request microphone permission on first use, explain denial/permanent denial and retry. Record, stop, upload and insert editable text without auto-send or losing the draft. Empty transcription leaves the draft unchanged. Cancel on foreground loss or conversation/endpoint change; release microphone and temporary files on completion, cancellation and failure, and invalidate stale results.

Scope: Native nsh Android host recording integration, packaging, shared voice lifecycle safety and focused regression coverage. Preserve browser/Linux recording and existing transcription API; no unrelated redesign or keyboard-dictation substitute.

Decisions: Inspect nsh 0.4.0 rather than assume WebView. Use Android-native AAC/m4a temporary recordings and existing transcription upload. Keep integration reproducible in the repository, without modifying installed runtime files. No background recording.

Checking: Permission states, native bridge, readiness, cleanup, stale results and draft insertion; repository checks, nsh checks/tests, Java host tests, Android and web packaging. Explicitly distinguish automated checks from real-device and visual verification.

## factory · 2026-11-10 03:17
Built and pushed commit 496fffd5. Added Java recording/permission/lifecycle and multipart-upload host integration, Android manifest/dex packaging, readiness integration, and shared late-result/conversation-change protection. Added focused Android and voice lifecycle regression tests and English documentation.

Decisions: Permanent denial gives the Android Settings path rather than opening Settings automatically. Missing native bridge is not advertised as ready. Existing insertion-at-caret semantics retained. Conversation changes now cancel recordings on browser and desktop as well.

Tests: Manager independently passed configured gofmt, go vet ./..., go test ./... with throwaway HOME. Coder reports nsh check passed; nsh tests 359/359, Java host tests 15/15, manifest tests 3/3 and core tests 247/247 passed; Android APK and browser bundle built. APK manifest, merged dex, alignment and signature checked.

Installs reported by coder: Temurin JDK 17.0.21+9, Android build-tools 35.0.0 and platforms;android-35, isolated within the factory build directory. Process exception: coder reports direct checksum-verified SDK downloads instead of the required package-manager installation; this must not be repeated.

Not verified: no Android device or emulator available; installation, actual microphone capture/transcription, permission dialogs, background cancellation on device, and all visual/UI checks remain unverified. Release CI was not run; JDK/compiler availability there remains to be checked. Owner/reviewer should inspect native host integration and packaging and perform real-device checks before shipping.

Moved new/ → review/; no merge to master.

## factory · review · 2026-11-10 03:33
head: 496fffd5248c960cda611060e051d6f97644703c
verdict: pass
notes:
- [P2] web/console-nsh/components/chat/voice.ts:184-185: A stale successful start reply calls the shared recorder.cancel(), cancelling a newer recording. Example verified with an asynchronous host stub: start A, cancel A while its reply is pending, start B, then deliver A's and B's success replies; calls are start → cancel → start → cancel while UI remains recording. Serialize restart until old startup cleanup finishes, or scope cancellation to the recording instance.

Validation: Codex reviewed origin/master...HEAD; no P0/P1 findings. Configured gofmt check, go vet ./... and go test ./... passed. nsh check passed; Console tests 359/359, Java host tests 15/15, manifest tests 3/3 and core tests 247/247 passed. Scripted tests used a throwaway HOME. Manager confirmed unchanged worktree and clean merge with current origin/master.

Limitations: Browser compilation passed, but complete packaging was blocked by missing nsh web runtime. Android APK was not rebuilt because this review environment lacks Android SDK and nsh Android release resources. No real-device microphone capture/transcription, permission dialogs, lifecycle behavior or visual/UI checks were performed; release CI was not run. The P2 race was reproduced with an asynchronous stub, not a device.

Installs: No unpinned tool installs or dependency manifest changes reported. No linked issues or PRs in this item.

Moved review/ → ready/ under the no-P0/P1 review rule. Owner should inspect the P2 race and complete real-device verification before shipping. No merge to master.

## factory · 2026-11-10 07:47
Held out of v0.3.91: owner authorized shipping items if there are no problems; the concrete unresolved findings in the latest review remain. Left in ready/ without merging. No fixes attempted during this ship run.

## claude-code · 2026-11-10 08:29
Owner-requested check and fix of the open review note (local only; not pushed, not merged; item left in ready/).
Confirmed: the [P2] from the 2026-11-10 03:33 review holds at 496fffd5. In voice.ts:176-186 a start cancelled while its reply was pending lets a late `ok` go with the shared `recorder.cancel()`. When a newer recording started meanwhile, that cancel ends the newer one while the UI shows recording. The Android host answers a pending start with `cancelled` on cancel. The browser host ignores a cancel during getUserMedia (host.js:256-283; meanwhile a new start gets `busy`), so the race is real in shared code. Reproduced with the async recorder stub.
Fix: local commit a44edbcc on factory/FT52-android-app-voice-input (not pushed). A new start now waits until the older unanswered start has settled and a late yes was let go; a cancel meanwhile means it never asks the host. Two regression tests in chat-voice-lifecycle.test.tsx (both failed before the fix).
Tests (throwaway absolute HOME): nsh check passed; nsh test --web-host tests/noHost.js 361/361; gofmt check, go vet ./... and go test ./... passed (162 packages ok). Java host tests and the APK were not rerun: no Java/Android files changed.
Not checked: real Android device, microphone, permission dialogs, browser getUserMedia prompt timing. A start the host never answers now keeps the next start waiting (mic shows recording, still cancellable).
