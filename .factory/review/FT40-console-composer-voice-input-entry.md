---
branch: factory/FT40-console-composer-voice-input-entry
round: 1
---
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

## factory · plan · 2026-11-09 08:56
Behaviour: Trace composer endpoint selection, host recording capability and server transcription readiness. With a ready applicable route, show the existing microphone icon control; loading, missing and failed readiness must not offer a ready recording action. Preserve permission errors, unsupported/insecure explanations, stop/discard/transcribing and editable draft insertion. Refresh readiness when its relevant inputs change, ignoring stale async responses.
Scope: Voice-entry availability and icon-button accessibility/touch size plus focused regression tests. Do not redesign the composer, change model routing semantics or implement unrelated queued items.
Decisions: Reuse the existing icon-only control and recording workflow rather than add another. Diagnose the actual missing-entry cause before editing: createVoiceInput currently selects recording once from host availability and otherwise uses Speech.available; browser route checks only react to endpoint. Cover the concrete failing path, not a speculative cause. Retain native speech behavior unless a demonstrated defect requires adjustment.
Checking: Tests for ready/unavailable/error/initial and changed readiness, stale checks, icon accessible label and mobile touch target. Run repository gate and nsh check/test; attempt desktop/mobile rendering checks using existing tooling, and explicitly report missing physical mic/device or visual checks.

## factory · 2026-11-09 08:56
Built and pushed c0e2cfa1 on factory/FT40-console-composer-voice-input-entry.

Diagnosis: browser recording already exposed the icon with a ready route. Desktop GPUI has no Speech implementation, so the previous native-only availability check always hid it without consulting transcription readiness. Added the desktop recording host adapter needed to reuse the existing upload/transcription workflow: Linux pw-record/parecord/arecord, cleanup and bounded process termination. This extends the initial availability-only scope because showing a working desktop action requires a recorder. No system recorder was installed.

Route readiness refreshes on agent changes and returning to the foreground; stale replies are ignored, failed checks hide the entry. Same-agent refresh preserves the prior answer until completion. The icon is 38 points with a 3-point hit slop, accessible label and recording/transcribing states. Desktop does not offer an unusable live-preview toggle.

Limitations for review: Linux desktop recording only. macOS/Windows expose an explanatory no-recorder entry, not working recording. Android remains unchanged and has no voice entry; the mobile check below is browser-only. Review should assess this platform gap against the request before approval.

Verification: manager independently passed gofmt check, go vet ./..., go test ./..., nsh check, and all 290 nsh web-host tests. Coder reports desktop cargo tests 55 passed/2 ignored, plus the separate live Linux recorder test passed. Coder checked real Chromium desktop/mobile viewports with a fake microphone: icon visibility, record/stop/upload, and transcription failure recovery. No desktop app window check, physical phone, macOS/Windows check, actual speech-to-text, or real-window foreground-refresh check; refresh is covered by automated tests only.

Installs: none; reused pinned/cached tooling and temporary library symlinks.

Other observations: coder reports its scratch server sent a dummy API key to OpenAI during a heartbeat and transcription request despite a locally configured profile endpoint. No real key was used. This possible pre-existing endpoint-selection issue was not fixed or independently diagnosed in this item.
