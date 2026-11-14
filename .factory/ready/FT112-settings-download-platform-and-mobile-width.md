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

## factory · review · 2026-11-14 12:11
head: dcac7267d0deadb05ccc622e022d343d00e4684e
verdict: fix
fix:
- [P1] web/console-nsh/tests/chat-composer-drum.test.tsx:43: required full Console suite fails intermittently (linux typing test: expected 0 to be 1). Restore a green required suite by stabilising the test without weakening its assertion; the same failure reproduces on baseline, so do not change FT112 download logic to address it. Factory policy treats a failing required test as P1; this is a validation blocker, not an introduced FT112 defect.
notes:
- Claude Code reviewed origin/master...HEAD (merge-base 75eec416), all 18 files and 2 commits; no confirmed defects introduced by FT112. The branch merges cleanly with master. Review-only worktree remained clean; no commits or installs.
- Required gofmt/vet/go test command passed (163 packages ok); nsh 0.5.0 check passed. Full nsh suite: 937 tests, 936 passed, 1 failed (linux drum typing). All 33 new/changed FT112 tests passed.
- Verified example: full suite reaches the linux drum typing assertion with presses=0 instead of 1. Isolated drum repeats: HEAD failed twice (linux, then linux+android) and passed once; baseline 75eec416 passed twice and failed once (linux). This confirms a pre-existing intermittent failure, not causality from the download changes.
- Used repository-required, already installed nsh 0.5.0 rather than incompatible default 0.4.0. Tests used absolute throwaway HOME; installs: none.
- Not checked: real Android hardware/emulator, APK build/install, real artifact downloads/live release feeds, real browsers including Android desktop-site mode, GPUI desktop or live Go server. Automated Android target and mobile/desktop layout tests passed.
- Round 1 of 3: review/ → new/ for the required-suite blocker. Owner should inspect the baseline flake evidence; factory cannot waive the test gate automatically. No linked issues or PRs.

## factory · 2026-11-14 21:09
Moved new/ → review/ at the owner's explicit request: "move FT112, FT113, FT118 to review/". No code changes or tests run; existing review findings remain recorded. This move is not a passing review or a test-gate waiver.

## factory · review · 2026-11-14 23:24
head: dbb8a47c1a445a75c26cb67751a67bb9e27a0616
verdict: pass
notes:
- Claude Code reviewed origin/master...HEAD: merge-base 2e37a15f, master 45bf4165, 18 changed files. No verified introduced defects meeting the finding standard; no P0/P1 blockers. Android native targeting, exact client selection and unavailable states, legacy-server fallback, server-updater compatibility, stale-state clearing, checksums and localization reviewed.
- Validation on this head: configured gofmt/vet/go-test gate exit 0 (163 packages ok); full nsh 0.5.0 Console suite 942/942 passed, exit 0. Manager independently reran nsh 0.5.0 check: exit 0. Scripted tests used absolute throwaway HOME. The prior drum gate blocker was removed upstream in 2e37a15f and brought here by merge, not weakened by this feature.
- Candidate comments were not retained as findings: Android desktop-site and reduced Linux browser hints rely on unverified browser behavior; archive-vs-installer behavior predates this item; the 980pt breakpoint is the existing responsive convention; release-feed URL trust concerns lack a verified attacker-controlled entry or demonstrated regression. Browser-hint and outbound URL/openExternal behavior remain residual checks, not proven defects.
- Not checked: real Android hardware/emulator, APK install, live artifact downloads/feeds/server, real browser desktop-site and secure-context architecture hints, Safari/Firefox/Windows/iPad, GPUI desktop, rendered intermediate-width layouts and non-HTTP external URL handling.
- Installs: none reported. Worktree stayed clean; no code changes or code commits. Initially stale local item branch was fast-forwarded to the fetched origin head before review; final review head matches origin. No linked GitHub issue/PR in the request; no GitHub comments required.
- Round 1 of 3: review/ → ready/. Owner should inspect real-device download selection and mobile layout before shipping. Not merged or deployed.
