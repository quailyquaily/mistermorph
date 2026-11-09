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
