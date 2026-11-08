# Set all task execution concurrency defaults to eight

## factory · 2026-11-09 06:33
The owner requested in Telegram: “OK，默认值都改成 8。加到 factory new”. This refers to the channel, cron and Console task-concurrency limits discussed with FT39.

Requirements:
- Set the shared channel task-concurrency default and all channel-specific task-concurrency defaults to 8; audit channel fallback paths for remaining defaults of 3.
- Keep cron.max_concurrency at its existing default of 8 and verify its omitted-value behavior.
- Set the console.max_concurrency default introduced by FT39 to 8. Coordinate with FT39; do not duplicate its scheduler work. If FT39 has not landed, implement this item after it.
- Preserve explicit user overrides, including 1. This changes defaults only, not existing deployment configuration or a process-wide aggregate limit.
- Update assets/config/config.example.yaml and relevant English documentation to consistently state 8. Do not modify config.yaml.
- Add regression tests for omitted settings resolving to 8 across all task runners, explicit values remaining effective, and existing invalid-value handling remaining consistent.

Acceptance: channels, cron and Console each default to eight simultaneous independent tasks; same-topic ordering and configured upper limits remain intact. No unrelated concurrency settings (network pools, tool parallelism, etc.) are changed.

This item records requested work only; no code or deployment changes have been made.
