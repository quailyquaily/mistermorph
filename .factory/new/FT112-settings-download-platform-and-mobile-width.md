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
