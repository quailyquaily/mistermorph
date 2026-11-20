---
branch: factory/FT162-unified-updates-panel
round: 1
---
# Simplify Settings Updates into one unified Shell and server panel

## factory · 2026-11-20 08:55
The owner requested this task in new/:

> settings -> updates, no need pro channel, so no need to ask user to choose channel.
> Shell and server version, put them in one space, so we only need one refresh button and one place to show the new updates change log. So please rearrange the updates panel for better ux.

### Required behavior
- Rearrange Settings → Updates into one coherent area containing both Shell and server version information. Clearly label each component and distinguish installed versions from available versions.
- Remove the Pro channel option and the channel-selection control/prompt from this panel. Checking for updates must not require the user to choose a channel. Use the supported non-Pro/default release source automatically; do not add another channel-selection step elsewhere.
- Provide one shared refresh/check-for-updates button that checks all applicable components. Present loading, up-to-date, update-available, and failure states clearly; a failure checking one component must not hide a successful result for the other.
- Provide one shared changelog/release-notes area for available updates rather than separate duplicated areas. Identify which component and version each entry describes, and avoid duplicating identical notes when components share a release.
- Preserve any necessary component-specific install/update actions and existing safety checks. A single refresh button does not mean silently combining update installation or restarting either component.
- Handle environments where only one component is available or updatable without displaying broken or misleading controls. Preserve usable responsive layouts on mobile and desktop, and existing localization/accessibility conventions.

### Scope and verification
- Inspect the current Settings Updates implementation and existing update-target tests before choosing the layout. Keep this focused on simplifying the update UX; do not remove unrelated backend release-channel support or change release infrastructure unless required by the panel behavior.
- Add/update regression coverage for no channel selection or Pro option, a single shared refresh control, checking supported components, partial failures, and the unified release-notes display.
- Run configured repository checks and required Console checks/tests. Visually check mobile and desktop layouts where feasible; explicitly report any checks not performed.

## factory · plan · 2026-11-20 09:19

Behaviour: On first load show installed Shell (native only) and server versions together. Do not expose channel choice or Pro option; checks use community explicitly irrespective of saved channel without silently changing stored settings. One shared refresh starts all supported checks and guards duplicate requests. Results and errors remain independent so partial success survives. Unsupported or unknown shell versions retain explanatory text and no broken action; browser shows server only. Display available versions next to clearly identified components. One release-notes area groups available updates by version and normalized notes, labels each contributing component, and avoids duplicate identical shared-release notes. Keep separate explicit safe component-specific download/install actions, automatic-update setting, endpoint-race protection and revision checks.
Scope: Focus SettingsAppPanel.tsx Updates UI, relevant helpers, localization catalogs and regression tests. Preserve backend channel/release infrastructure; do not alter unrelated settings or deployment.
Decisions: Community is the supported non-Pro default, explicitly requested by checks; no settings-channel mutation just to refresh. Refresh all applicable targets concurrently with per-target error handling. Consolidate notes, not installation. Preserve existing device-target download choices and accessible responsive rows; update obsolete tests/assertions for removed selectors and refresh controls.
Checking: Add regression coverage for no Pro/channel selector, exactly one refresh control, web/native supported target checks, unavailable shell, partial failure both directions, community requests despite saved pro, deduplicated/shared vs distinct release notes and correct component-version labels. Run gofmt cleanliness, go vet ./..., go test ./...; nsh check and required scripts/test.sh. Use available layout fixtures for mobile/desktop; explicitly report whether actual visual inspection was possible.

## factory · 2026-11-20 09:19

Built at 3741ead2. Shared Shell/server version list, one concurrent community-only refresh with independent errors, and one release-notes area deduplicated by version and normalized notes. Component-specific downloads and safety checks remain separate. Removed channel selector/Pro option and obsolete settings-search entries; updated en/zh/ja strings and English docs. Existing non-Community installed build labels remain informational; no saved channel is changed by checking.

Installs: none; no manifests or lockfiles changed.

Checking: manager independently ran gofmt cleanliness, go vet ./..., and go test ./... successfully. Coder ran nsh check successfully and required Console scripts/test.sh: 145 files, 0 failed. Regression tests cover shared control, community despite stored Pro, supported/unavailable targets, duplicate-request guard, partial failures both ways, and shared/distinct notes.

Visual checks: coder inspected headless Chrome screenshots at 1280×800 and 390×844 with mocked API and simulated phone boot, using available nsh 0.5.1 web runtime (0.6 web runtime unavailable). Not visually checked: real GPUI desktop, actual Android device, surrounding full Settings page, or zh/ja layouts. Review should inspect these limitations and shared notes/download presentation.

Moved new/ → review/. Code branch pushed; no base merge or tag. Initial code push lacked repository credential path; retried successfully with command-local credential.useHttpPath=true.

## factory · review · 2026-11-20 09:31
head: 3741ead2a6872fdc97706d409bf67e9fae60bb40
verdict: pass
notes:
- No qualifying defects found; no P0/P1. Reviewed all eight changed files against the request and plan with Claude Code, using the review-code skill.
- Community checks on an installed Pro build can offer a channel switch even at the same version. This is the explicitly planned community-only behavior, not a defect against this request; the coder's proposed P3 was excluded for that reason. Owner should confirm whether existing Pro installations still matter.
- Validation passed: gofmt cleanliness, go vet ./..., go test ./... (165 packages ok); nsh check (0.6.0); required Console scripts/test.sh (145 files, 0 failed; seven unrelated parallel failures passed the script's solo retries); extra JavaScript tests (280 passed).
- Installs: none. Worktree remained clean; no code commits.
- Visual limits remain: no real GPUI desktop, Android device, full Settings page or zh/ja visual checks. Frame-probe layout tests passed. On Pro desktop with automatic updates enabled, checks can cache a Community package via existing host behavior; no install occurs, and this path was inspected but not executed.

Moved review/ → ready/. No base merge, tag or code push.

## factory · 2026-11-20 10:25
Shipped: merged into master as 762264721e7f6bcb77a51bfa999617c717fc9d6f, tagged v0.3.122 and pushed. No linked GitHub issues or PRs to close. Branch kept (the ship does not delete branches here).
