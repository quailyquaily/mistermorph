---
branch: factory/FT112-settings-download-platform-and-mobile-width
round: 1
---
# Settings download: correct Android artifact and full-width mobile button

## factory · 2026-11-14 06:55
Owner request from Console:

> The download button in the settings seems not correct. It will download the Linux version on the Android app. And the download button width on mobile view should be block width.
> Put it to new/

### Required behavior
- Investigate and fix platform selection for the download button in Settings. In the Android app, it must select the appropriate Android download, not a Linux desktop artifact. Do not infer the client platform from the runtime server's operating system or classify Android as desktop Linux merely because its platform/user-agent contains Linux.
- Preserve correct download selection for other supported platforms and architectures. Use the existing release/download mechanism; if no compatible artifact is available, show an honest unavailable state or explicit platform selection rather than silently offering an incompatible binary.
- On mobile/narrow viewports, make the download button full width within its containing section, respecting padding and without horizontal overflow. Preserve the existing desktop layout.

### Acceptance checks
- Verify Settings in the Android app chooses an Android artifact and never defaults to a Linux desktop binary, including when the runtime server is Linux.
- Add regression tests for Android-versus-Linux detection and existing supported platform selection; cover unknown/unavailable platform handling.
- Verify the button spans its container's usable width on mobile, including long labels, and remains usable without overflow; check desktop layout remains unchanged.
- State any Android app, actual download, or browser layout checks that could not be performed.

Status: requested only; no implementation or cause diagnosis yet.


## factory · plan · 2026-11-14 11:43

### Behaviour
Detect the download target from the client, never the runtime server: Android takes precedence over Linux. Select the exact published OS/architecture, or show explicit architecture choices/unavailability. Keep initial, failed and channel-switched checks free of stale downloads. Mobile buttons fill the available card width and wrap long labels; desktop retains natural sizing.

### Scope
Client host platform metadata, existing release-check API and selection, Settings download/checksum presentation, responsive Button option and regression tests. Exclude server automatic-update targeting, release publishing and unrelated UI.

### Decisions
Use authoritative native OS or browser platform/architecture hints; do not guess unknown architectures. Use published Android release.json APK metadata because Android is not in the desktop update manifest. Unknown or unavailable builds never silently fall back to a server binary. Keep callers without a client download target backward compatible.

### Checking
Add Android-on-Linux-server, platform/architecture, unknown/unavailable, channel/error, older-server and mobile/desktop layout regressions. Run gofmt, go vet, go test, nsh check and the full Console suite; distinguish mocked browser coverage from actual device/download checks.

## factory · 2026-11-14 11:43

Built and pushed da46a42f and dcac7267 on factory/FT112-settings-download-platform-and-mobile-width. Client download_os/download_arch now select a separate download result without changing the server updater. Android uses the release APK and checksum; desktop selections preserve exact architecture or offer published architecture choices. Unknown/unavailable targets and incompatible older-server responses point to releases instead of an unrelated binary. Mobile buttons stretch and wrap, with localized platform labels and matching checksums.

Plan adjustment: when an explicit client target is requested and the server platform is absent from the manifest, return the client selection without server asset fields; ordinary/server automatic checks retain their prior errors.

Installs: none unpinned; no manifest or lockfile changes. Used already available pinned nsh 0.5.0 and runtime; the default nsh 0.4.0 is incompatible with the current Console suite. Manager's first full attempt timed out; its full 0.4 run produced 96 failures, with representative identical baseline failures confirmed by the coder. Retested using repository-required nsh 0.5.0.

Validation: manager independently passed gofmt cleanliness, go vet ./..., go test ./... and nsh check. Full nsh 0.5.0 suite after coder retry: 937 tests, 935 passed, 2 failed. Failing tests:
- tests/chat-composer-drum.test.tsx: linux: typing turns the drum to Send, clearing turns it back, and it rests as the buttons.
- tests/chat-composer-drum.test.tsx: android: typing turns the drum to Send, clearing turns it back, and it rests as the buttons.
Coder confirmed these are intermittent baseline failures and isolated repeats pass on baseline and this branch. All 190 tests in the 17 files implicated by the incompatible-tool run pass with 0.5.0. Full suite is NOT green; review must see these failures.

UI checked by coder in real headless Chrome against stubbed APIs: emulated Android selects APK, mobile full width, 300pt long-label wrapping without overflow, desktop natural width at 1280pt. Automated native-Android fixture and 320/390/1280pt layout tests added. Not checked: real Android hardware/emulator, APK build/install, real artifact downloads/live release feeds, HTTPS architecture hints, Safari/Firefox/Windows/iPad, live Go server or GPUI desktop.

Push initially refused because credential requests lacked repository path; one retry with per-command credential.useHttpPath and GH_REPO succeeded. No changes outside allowed item scope; no forbidden paths changed. Moved new/ → review/, round 1.
