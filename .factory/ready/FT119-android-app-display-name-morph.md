---
branch: factory/FT119-android-app-display-name-morph
round: 1
---
# Rename the Android app display name to Morph

## factory · 2026-11-14 08:24
Owner request: "Rename the Android app display name to \"Morph\"\nPut to new/"

Requirements:
- Set the Android app's user-visible display name to exactly `Morph`.
- Update the relevant Android label resources and any locale or build-variant overrides so the installed app consistently displays `Morph`.
- Keep the application ID, package name, signing configuration, and existing app behavior unchanged.

Acceptance checks:
- The installed Android app appears as `Morph` in the launcher and Android app settings.
- No existing locale or supported build variant restores the old display name.
- Android resource/build checks pass; explicitly note if device verification cannot be performed.

Scope: Android app display name only; no icon, web branding, or application identifier changes.

## factory · plan · 2026-11-14 20:03
Behaviour: Set the Android application's label to the literal Morph in the existing Android-only manifest patching step, before resource linking for APK/AAB builds. Replace old literal/resource labels or add a missing label. Relabel explicit launcher component/intent-filter overrides; retain unrelated labels. Keep patching idempotent.

Scope: Android manifest patcher, regression tests, packaged APK label validation, and Android Settings microphone guidance in English/Chinese/Japanese. Leave shared nsh.json name, application ID/package, artifact filename, icons, signing and web/desktop branding unchanged.

Decisions: A literal Android-only label avoids localized resources restoring the old display name. Reuse the current build pipeline; no new dependency or alternative packaging system.

Checking: Regression tests for literal/resource/absent labels, launcher overrides, unrelated components, unchanged package and idempotency. Run Node tests, shell syntax check, configured Go checks, nsh check and Console tests. Compile/link Android resources with available SDK tooling; report full packaging/device limitations.

## factory · 2026-11-14 20:03
Built in 9b53b252b884e9eab25a293714c7d58df156db32. Android app/settings and launcher labels are Morph; Android permission guidance now uses that name in all three existing locales. APK packaging validates application/launcher labels using aapt2 badging. Shared name, package ID, icons and signing are unchanged.

Installs: none. No dependency manifest or lockfile changes.

Tests: gofmt cleanliness, go vet ./... and go test ./... passed, independently rerun by the manager with throwaway HOME. Node manifest tests: 9/9 passed. bash -n passed. nsh check passed; nsh test --web-host tests/noHost.js: 932/932 passed. Existing Android SDK aapt2 compile/link succeeded on nsh 0.5 manifest templates and Android resources; badging/xmltree confirmed Morph labels and inherited launcher label. These resource-only APKs are unsigned and not installable.

Not checked: Full APK/AAB packaging was not run because nsh Android runtime/nsh.aar are unavailable locally and the script would download binaries. No device/emulator was used; launcher and Android Settings UI were not visually verified. Review should inspect actual packaging/device labels before release.

Push note: first credential-helper attempt lacked repository path; retry with command-local credential.useHttpPath=true succeeded. No persistent credential configuration changed.

## factory · review · 2026-11-14 22:47
head: d4d44d53e88d8ddcf2cb47cb274af5790fb01393
verdict: pass
notes:
- Claude Code found no qualifying defects in origin/master...HEAD against base f9e8da5e. Android-only literal Morph label, launcher overrides, locale independence, idempotency, package preservation and APK badging gate were checked.
- Validation passed with throwaway HOME: configured gofmt/vet/go test checks (163 packages), nsh check, Console test script (107 files, no failures), Node manifest tests (9/9), and bash syntax check.
- Existing aapt2 resource-only APK checks verified localized labels all become Morph, package remains unchanged, gate rejects old labels, and the installed nsh manifest template patches and links correctly.
- No installs. Worktree unchanged. No linked GitHub issue or PR.
- Not verified: full APK/AAB packaging and actual launcher/Settings UI on a device; local nsh Android runtime/nsh.aar unavailable. AAB output has no badging gate. Owner should check an installable build before release.
- master advanced to 45bf4165 after validation; no merge into base or shipping was performed. Ship must validate integration against current base.
