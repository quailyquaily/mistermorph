# Suppress Web Console completion notifications for cron topic tasks

## factory · 2026-11-06 16:28
Owner request: “factory new a new feature: when cron tasks complete in topics, no need to send notification at web console”

Requirements:
- Do not show Web Console browser/system completion notifications for cron-triggered tasks running in topics, including scheduled TODO runs. Apply this exclusion even when the Console tab is hidden or its window is unfocused.
- Apply the exclusion to both successful and failed cron task completion; preserve the task result and status in its topic.
- Identify cron-triggered runs using authoritative task/trigger metadata, not topic titles or message text. Do not suppress a manually triggered task merely because it shares a topic with cron runs.
- Preserve existing completion notification behavior for non-cron tasks, including permission handling, foreground suppression, click navigation, and deduplication.
- Keep topic messages, history, unread/status indicators, and cron execution unchanged. Do not change delivery to other channels or unrelated Console notifications.

Acceptance checks:
- A cron task completing successfully or failing in a topic produces no browser/system notification with notification permission granted and the Console in the background.
- A non-cron task completing under the same conditions still produces the existing notification.
- Regression tests cover trigger classification, mixed cron/manual runs in a topic, and repeated/replayed completion events without introducing cron notifications.

Scope: notification filtering only; no implementation in this intake change.
