---
branch: factory/FT143-console-mobile-file-download-icon-button
round: 1
---
# Console mobile app: file downloads with an icon button

## factory · 2026-11-17 18:53

Owner request:
> Console in the mobile app must support file downloads. Use an icon button for the download action.

Context:
- A Console `send_file` text attachment was delivered successfully, but saving it in the phone app reported "Saving files is not available in the phone app yet."
- The prior investigation reported an explicit unsupported `morph.file.save` handler in `web/console-nsh/lib/mobileHost.ts`. Verify the current implementation and mobile host APIs before choosing a solution; do not assume ChatView is an embedded WebView or that blob downloads are the cause.

Scope and acceptance:
- Implement saving/downloading received Console attachments in the mobile app, including Android, through the supported mobile/native file-saving APIs. The user must be able to choose an appropriate destination and receive the original file contents with the correct filename.
- Use an icon button for the attachment download action, consistent with existing Console controls, with an accessible label and a usable mobile touch target.
- Handle in-progress state, user cancellation, unavailable capabilities, and actual download/save failures accurately. Do not report success before saving has completed or leave the current unconditional unsupported error on supported mobile paths.
- Preserve existing desktop/browser attachment downloads and existing attachment access checks. Do not introduce public file URLs or expose credentials.
- Add regression coverage for mobile host save handling, the download icon button and its states, cancellation/failure, and existing browser behavior. Run the required Console checks/tests; document whether Android/mobile end-to-end saving was actually verified and any platform limitations.

Requested status: new. Investigation and implementation are pending.

## factory · plan · 2026-11-17 19:42

Behaviour
- On a supported mobile build advertise saveFile only after confirming a working native capability. Saving a received attachment opens the platform destination picker with its original filename, downloads using the existing authenticated Console endpoint, and completes only once the bytes are written.
- Cancellation returns cancelled without an error/success message. Pending saves disable the icon action; failed downloads/writes show an accurate error and allow retry. Missing native support is handled explicitly and truthfully.
- Empty/fallback filenames use the existing safe default. First-run picker permissions use the platform's normal interaction; do not require broad storage permissions.
Scope
- mobileHost file-save integration, supported Android native handler and packaging as needed, received attachment icon button, regression tests. Preserve browser/desktop hosts and server access checks. No public URLs, server auth changes, or unrelated preview fixes.
Decisions
- Inspect pinned nsh APIs first; prefer supported built-in saving if available, otherwise the repository's existing Java host-extension pattern with Android ACTION_CREATE_DOCUMENT and streaming authenticated bytes. Do not assume a WebView. Other mobile platforms without a working API remain explicitly unsupported.
- Keep bearer credentials confined to the existing host request and authorized HTTP destination; never leak them through redirects, public URLs or logs. Preserve binary contents including empty files.
Checking
- Add tests for mobile capability detection, delegation/completion, cancellation, missing support, failure, icon accessibility/touch target and pending/error/retry states, and browser regression.
- Run nsh check and scripts/test.sh, plus gofmt/vet/go test gate. Validate Android integration/build where tools permit. Explicitly report physical-device/emulator and visual checks not performed.

## factory · 2026-11-17 19:42

Built Android native saving via ACTION_CREATE_DOCUMENT and authenticated streaming, with destination selection, exact binary/empty contents, cancellation, completion after close, failure cleanup and redirect refusal. Save capability is probed at boot. Received attachments now use an accessible icon button with 44pt touch target, pending/disabled state, success feedback and retryable errors; browser/desktop paths are retained. Added mobile/browser/UI, native Java and manifest regression tests. Updated English app/porting docs.

head: baa1869b
round: 1
Installs: none; no dependency manifest changes.
Checks: coder reports nsh check passed; required parallel Console script passed 133 files with 0 failed, plus affected tests rerun after final edit. Native Java suites passed, manifest tests passed 11/11. Manager independently ran the configured gofmt/vet/go test gate: passed.
Android limitations: no real nsh 0.5.1 APK build verified. Java compilation and manifest/link/packaging checks used locally cached 0.4.0 runtime artifacts as a compatibility smoke check only; the resulting mixed-version APK was deleted and is not an installable deliverable. No device/emulator end-to-end save, cloud-provider save, or visual/screenshot check was performed. iOS remains explicitly unsupported.
Review should inspect the native activity lifecycle, destination cancellation, failure cleanup, authenticated origin checks/redirect rejection and touch UI. This build does not claim verified on-device saving.
