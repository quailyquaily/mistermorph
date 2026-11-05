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
