---
branch: factory/FT18-console-suppress-cron-completion-notifications
round: 1
---
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

## factory · plan · 2026-11-06 17:35
Behaviour: classify completion by authoritative per-run metadata; suppress scheduled cron success and failure notifications, including scheduled TODO system notifications, before display. Preserve manual runs in mixed topics, invalid-event guards, first-load/replay behavior, permissions and notification error handling.
Scope: notification producers, trigger plumbing, Console filters and regression tests only. No scheduler execution, topic status/history, other-channel delivery or presentation changes.
Decisions: additive per-run metadata instead of topic/title heuristics. Missing client metadata keeps legacy behavior. Manual TODO Run now retains its existing opt-in system notification path without duplicate topic notices.
Checking: Go metadata/store/hub/WebSocket tests, JS hidden/unfocused success/failure, mixed manual/cron and replay coverage; full configured Go checks plus pnpm test/build. Actual browser/native notification behavior requires manual checking.

## factory · 2026-11-06 17:35
Built and pushed commit 6049e2ba. Recorded schedule/manual trigger references, passed stored triggers to completion hooks, filtered scheduled notifications in the server hub and added client cron guards on both notification paths. Removed topic-ID-based completion filtering.
Decisions: manual TODO runs use their existing notification target; legacy TODO triggers keep their prior topic-completion exclusion. Missing notification trigger metadata preserves existing client behavior.
Installs: none beyond restoration of pinned pnpm dependencies; no manifest or lockfile changes.
Checks: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...`, pnpm test (430 passed), and pnpm build (only large-chunk warning). Commit scope and protected paths checked.
Not checked: real browser notifications and desktop native notifications; UI behavior was not manually viewed. TODO target/permission wording is unchanged and still offers System notification, which now applies only to Run now. Owner should check notification behavior and this wording.
Moved new/ → review/ for independent review. No merge into master.

## factory · review · 2026-11-06 17:44
head: 6049e2ba391d2865451765a9daaac1eb3d170d92
verdict: pass
No findings. Codex reviewed all 13 changed files in origin/master...HEAD and relevant callers, including trigger metadata propagation, scheduled/manual success and failure paths, notification deduplication and replay. Branch merges cleanly with current origin/master.
Validation: configured gofmt check, go vet ./..., and go test ./... passed (156 packages passed, 17 without tests); pnpm test passed all 430 tests; pnpm build passed with only the large-chunk warning. Tracked worktree remains unchanged.
Installs: no unpinned tools or dependency manifest/lockfile changes.
Residual risks: actual browser and desktop native notifications were not manually viewed. Owner should check these notifications and the existing TODO System notification wording before shipping.
Moved review/ → ready/. No linked GitHub issues or PRs; no merge into master.
