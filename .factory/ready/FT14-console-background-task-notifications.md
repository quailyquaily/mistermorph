---
branch: factory/FT14-console-background-task-notifications
round: 1
---
# Notify when a topic task finishes while Web Console is in the background

## factory · 2026-11-05 11:08
Owner request: “新增一个 new，在 web console，如果 topic 的任务结束了但是 web view 不在前台，就发个通知。”

Requirements:
- When a topic task transitions to a terminal state while the Web Console view is not in the foreground, show a browser/system notification. Cover success and failure, with an appropriate short status label.
- Detect background/foreground state using browser visibility and focus signals; do not notify while the Console is visible and focused.
- Identify the topic in the notification; clicking it should focus/open the Console and navigate to that topic.
- Handle notification permission through an explicit user action. Unsupported browsers or denied permission must not break task execution or the UI; do not repeatedly prompt.
- Notify once per completed task. Reconnects, event replay, page reloads, and multiple open Console tabs must not produce duplicate or historical completion notifications.
- Keep notification content minimal; do not include task output or sensitive message contents.
- Scope is an open Console view in the background, not server push after the browser is closed.

Acceptance checks:
- A task completing with the Console in a background tab or unfocused window generates one notification when permission is granted.
- A task completing while the Console is foregrounded does not generate a notification.
- Clicking the notification takes the user to the correct topic.
- Cover permission denial/unavailability, failure completion, repeated terminal events, reconnect/reload, and multiple tabs in regression checks.

Status: new; implementation has not started.

## factory · plan · 2026-11-05 12:11
Behaviour: Notify once for live successful or failed topic task completion while Console is hidden or unfocused, after explicit permission. Visible and focused Console suppresses notifications. Clicking focuses Console and navigates to the topic. Initial load, reload and reconnect do not replay historical completions; denied permissions and missing APIs safely no-op.
Scope: Reuse the Console notification stream, add live completion events and explicit permission UI, localized labels and regression tests. No closed-browser push, unrelated cron behavior changes or unread-done badges.
Decisions: Only topic ID and short status in notification content. Use Web Locks and persistent claims for race-safe cross-tab deduplication; skip notifications when required capabilities are unavailable. Use local Console topic events, without extending remote endpoint support.
Checking: Go producer tests; JavaScript tests for success/failure, foreground/background, click destination, denied/unsupported permission, duplicate/replayed events, reload and concurrent tabs. Run configured Go checks plus console tests/build. Real browser notifications need manual verification.

## factory · 2026-11-05 12:11
Built and pushed commit 2088522fd15334af0bc9829b519e987e8c4b1937 on factory/FT14-console-background-task-notifications.
Added live local-topic completion notifications and explicit permission control in Settings. Cross-tab foreground locks suppress notifications while another Console tab is active; persistent atomic claims prevent duplicates. Notification text contains only topic ID and status; click opens its topic.
Tests: configured gofmt check, go vet ./..., go test ./... passed; pnpm test passed (397 tests); pnpm build passed with chunk-size warnings. Manager independently reran all checks successfully.
Installs: pinned dependencies restored with frozen lockfile; no unpinned tools or manifest/lockfile changes.
Not checked: real browser UI, OS notification display and notification-click behavior manually. Remote endpoint task notifications were not added; implementation covers local Console topics.
Moved new/ → review/ for review. No merge into master.

## factory · review · 2026-11-05 12:21
head: 2088522fd15334af0bc9829b519e987e8c4b1937
verdict: pass
notes:
- Codex reviewed origin/master...HEAD across all 13 changed files; no qualifying P0/P1/P2/P3 findings.
- Validation: configured gofmt check, go vet ./..., and go test ./... passed; pnpm test passed (397 tests); pnpm build passed with chunk-size warnings. Scripted tests used an absolute throwaway HOME.
- Residual risks: supplemental browser automation did not complete due to module-loading and CDP session errors. Native cross-tab locks, OS notification display, and real notification clicks remain unverified in a browser; review relied on code inspection and mocked tests for these behaviors.
- Installs: no unpinned installs or manifest/lockfile changes.
- Branch merges cleanly with origin/master. Worktree clean and reviewed HEAD unchanged. No linked issues or PRs to comment on.
- Moved review/ → ready/. Owner should manually verify native notifications and click navigation before ship; no merge into master.
