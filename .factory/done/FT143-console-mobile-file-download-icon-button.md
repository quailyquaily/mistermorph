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

## factory · review · 2026-11-17 19:55
head: baa1869b2aaea578d0bce4fae2f457c79a0fe25c
verdict: pass

No findings. Claude Code reviewed all 20 changed files against origin/master...HEAD and the request/plan, including native activity lifecycle, picker cancellation and failure cleanup, authenticated origin checks and redirect refusal, capability detection, browser/desktop compatibility and icon accessibility/state.

Validation: configured gofmt/vet/go test gate passed; nsh 0.5.1 check passed; required parallel Console test script passed 133 files, 0 failed (7 unrelated files passed the script's isolated reruns); Android host Java suites passed 15/15 each; Android manifest tests passed 11/11. Worktree stayed clean. Installs: none; no dependency manifest changes.

Residual risks: Android-dependent classes and a real nsh 0.5.1 APK could not be compiled/built in this review because the Android SDK android.jar and nsh 0.5.1 AAR were unavailable. No device/emulator end-to-end save, cloud-provider destination or visual check. Real runtime manifest integration, storage-provider write-mode behavior and Android automatic gzip/length handling remain unverified platform details, not confirmed defects. iOS saving remains explicitly unsupported. Owner should verify a genuine 0.5.1 Android build and on-device saving before release.


## factory · 2026-11-17 21:17

Shipped with Claude Code. Conflict-free merge into master: 5888d1597cb87cc47563cfd7ffc9fc708bcef305. Annotated release tag: v0.3.117. Atomic master/tag push succeeded; remote master and peeled tag verified at b054491a2860a8aeebb698cf41d56b94e814d297. No fix commits; forbidden paths unchanged.

Final merged-base validation: gofmt, go vet ./..., go test ./... passed (163 packages ok, 19 without tests); nsh 0.5.1 check passed; required parallel Console runner 135/135 files, zero failures/retries; Console Node helpers/manifest/inventory 288/288; Cloudflare Node tests 24/24; native Java host tests three suites of 15/15. No installs or manifest dependency changes.

Limits: no genuine nsh 0.5.1 Android APK build, physical device/emulator saving/preview or new visual validation. FT144 fullscreen retry/ticket-error P2 and FT145 gallery accessibility translation P3 remain unchanged. No linked issues or PRs identified. Branch retained (clean is not configured). Moved ready/ → done/.
