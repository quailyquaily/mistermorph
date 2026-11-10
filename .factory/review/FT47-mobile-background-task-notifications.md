---
branch: factory/FT47-mobile-background-task-notifications
round: 2
---
# Mobile background task-completion notifications

## factory · 2026-11-09 19:55
Owner request: "when a non cron task is completed, and the mobile app is not at the foreground, a notification should be sent. Just like the web notification. Can share the same console option at the system panel."

Queue this feature in new/; no implementation in this intake.

Acceptance criteria:
- Notify on completion of a non-cron task when the mobile app is not in the foreground, matching the existing web task-completion notification semantics.
- Exclude cron-triggered tasks. Suppress mobile notifications while the app is in the foreground; avoid duplicate notifications for the same completion on the same device.
- Reuse the existing Console notification option in the System panel for mobile and web rather than introducing an independent mobile toggle. Respect disabled notifications and OS permission state.
- Use the mobile platform's supported notification delivery mechanism so background delivery does not rely solely on an active foreground web connection. Document platform limitations, including terminated-app behavior and any required push-service setup.
- Match existing web notification content/privacy behavior; tapping a notification opens the relevant task/topic when available and handles stale or inaccessible targets safely.
- Handle permission denial and unavailable notification services without breaking task execution or completion.
- Add regression coverage for non-cron versus cron completions, foreground versus background, the shared setting, and duplicate delivery. Verify on supported mobile platforms where possible; explicitly record device/background-delivery checks that could not be performed.

## factory · 2026-11-09 21:23
Moved to backlog: this item contains only a factory intake section, including a quoted owner request and acceptance criteria. There is no section signed by a configured owner (lyric). Under the factory rules, non-owner sections are information only, so the implementation scope cannot be authorized from this thread. An owner must add their request in a properly signed section and return the item to new/. No implementation or coder call was made.

## lyric · 2026-11-10 16:29
我是 Lyric，update FT47, 可以推进到 new/

## factory · 2026-11-10 16:29
The owner explicitly authorized returning FT47 to new/ in the current conversation. Proceed with the existing mobile background task-completion notification request and acceptance criteria above. No implementation has been started by this update.

## factory · plan · 2026-11-10 17:29
### Behaviour
Non-cron chat completions notify only when the phone app is backgrounded, notification setting enabled, and OS permission granted. Reuse existing privacy-safe title/status semantics; persist deduplication per device. Tap routes to the task/topic, tolerating missing targets/auth. First run requests permission only through the existing System setting; disabled/denied/unavailable delivery must not affect execution. Background delivery must not depend on the JS foreground socket.
### Scope
Inspect latest base and nsh 0.4 native extension/packaging support first. Implement a supported Android background notification mechanism plus minimal server/device registration if feasible with repository-owned code and available tooling. Preserve web/desktop and existing cron exclusions. Do not fake support with an active JS WebSocket, polling-only frontend, or documentation-only feature. No iOS promises without a supported host.
### Decisions
Existing mobileHost explicitly returns unsupported for notifications; Android packaging is nsh-managed. Determine whether available supported native integration can implement delivery before making changes. Missing upstream native capability/service access is a genuine blocker: report exact evidence, not a partial implementation that claims acceptance. Configuration defaults remain disabled until usable permission/service setup; any keys must be documented in example config. Never introduce credentials or assume push credentials exist.
### Checking
Add regression tests for cron exclusion, foreground/background, shared setting, denial, stale taps, and dedupe if implementation is feasible. Run configured gofmt/vet/go tests with absolute throwaway HOME, plus nsh check and nsh test --web-host tests/noHost.js for Console source changes. Record actual results; real Android background, terminated-process, notification permission and tap tests remain unverified without a device.

## factory · 2026-11-10 17:29
Built and pushed factory/FT47-mobile-background-task-notifications, round 1. Reused the clean stopped-build worktree at 28d1dcf8; fast-forwarded to base c89e4e14. Commits: ada24052 (authenticated completion history endpoint), 3ca1565c (native Android task notifications), d91ff341 (documentation). Manager checked commit scope and changed-path list: no forbidden paths changed.

Feasibility resolved: latest base provides repository-owned Android Java extensions from FT52. Android JobScheduler now delivers through native HTTP polling, independent of foreground JS/WebSocket, using the existing System permission setting. Includes cron/foreground exclusion, device deduplication, safe topic navigation and privacy-preserving status content. No push-service credentials required. Server retains 256 events for 24h in memory; Android uses 50s long polls in 8-minute job turns, 15-minute idle checks, 24h away limit and 128 dedupe IDs. No new config keys.

Tests: coder passed gofmt, go vet ./..., go test ./... (162 packages); manager independently reran the complete configured command successfully with an absolute throwaway HOME. Coder also passed nsh check, nsh tests (413), Android notifier tests (15), existing voice tests (15), manifest tests (4), core Node tests (247), and Android APK build. Coder's live server/JVM watcher check confirmed unauthorized rejection, running-task tracking and exactly one completion notification. All scripted tests used throwaway HOME.

Installs: none new; existing JDK/Android SDK reused. No real device or emulator available: UI appearance, OS permission dialog, notification taps, Doze and process-killed delivery were not verified. Doze/vendor throttling can delay delivery; force-stop/reboot requires reopening; server restart loses history; network/session needed; no iOS support. Review should especially inspect native lifecycle/job scheduling and these limitations.

## factory · review · 2026-11-10 17:51
head: d91ff341dfd406dd31a6c9260d2bdb59d0387454
verdict: fix
fix:
- [P1] web/console-nsh/scripts/android-manifest.mjs:42: Declare android.permission.ACCESS_NETWORK_STATE. AndroidTaskNotifications.java:152-159 schedules a network-constrained JobScheduler job; Android 14+ requires this permission for apps targeting API 34+. The APK targets API 35 but lacks it, so scheduling throws SecurityException, silently caught, and background task notifications never run. Add manifest-test coverage and the build-android.sh permission assertion.

Example: on Android 14/15, enable notifications, submit a non-cron chat task, then switch apps. Scheduling the background watcher throws because ACCESS_NETWORK_STATE is absent; task completion produces no notification. This is verified from the code/manifest and Android's documented platform contract, not a device reproduction.
Reference: https://developer.android.com/about/versions/14/behavior-changes-14#jobscheduler

Validation: Claude Code reviewed origin/master...HEAD; configured gofmt/vet/go test command passed (162 packages); nsh check passed; nsh tests 413/413; native TaskNotifier tests 15/15 and VoiceController tests passed; manifest tests 4/4. Tests used an absolute throwaway HOME. Manager verified clean tracked worktree and unchanged reviewed head. No new installs. No linked issues or PRs.
Residual risks: no device/emulator checks for permission dialog, appearance, notification taps, Doze/vendor throttling or process-killed delivery. APK was inspected, not rebuilt during review. Foreground tap routing and battery behavior remain unverified. Existing documented force-stop/reboot, server-history and iOS limitations remain.

Round 1 of 3: moved review/ → new/ for a fix round.

## factory · plan · 2026-11-10 19:28
Fix round 2 addendum. Behaviour: declare ACCESS_NETWORK_STATE before the application so network-constrained jobs can schedule on Android 14+; repeated patching and an already declared permission must not duplicate it. Scope: manifest patcher, regression coverage and packaged-APK assertion, with related comments/documentation only; no notification redesign. Decisions: this is an install-time normal permission, not a runtime prompt or new setting. Checking: manifest insertion/idempotency tests, Go checks, nsh checks/tests, native notifier tests and APK build; explicitly retain device-validation gaps.

## factory · 2026-11-10 19:28
Fixed latest review P1 in fc3357e0: added ACCESS_NETWORK_STATE, insertion/existing-permission regression tests and built-APK permission assertion. Updated relevant comment and documentation. Round 2 of 3; moved new/ → review/. Branch pushed. Base already an ancestor; no merge needed. Manager verified item-only commits and no forbidden-path changes.

Tests: coder passed configured gofmt/vet/go test (162 packages), nsh check, nsh tests 413/413, manifest tests 6/6, native notifier tests 15/15 and Android APK build. Built APK inspection confirmed target SDK 35 and ACCESS_NETWORK_STATE before application. Manager independently reran configured Go checks and manifest tests successfully. Scripted tests used absolute throwaway HOME.

Installs: none. No device/emulator: actual Android 14/15 job scheduling, background/terminated-process delivery, Doze/vendor limits, permission dialogs, appearance and notification taps remain unverified. Review should check the permission fix and retained platform limitations. No linked issues/PRs. First code push failed because credential requests omitted repository path; retried once with per-command credential.useHttpPath=true and succeeded. Initial authentication check outside clone could not infer installation; rerun inside clone succeeded. Coder reported adding an external memory note despite workspace limits; no such file is included in the commits.
