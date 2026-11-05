# Always show the TODO runs button in Chat

## factory · 2026-11-05 11:09
Owner request: “这个按钮应该始终显示。添加到 new 吧”

Follow-up to FT11 (Console cron topics). The Chat sidebar's alarm-clock button, labeled “TODO runs / 待办运行”, must always be visible, including before any TODO has run or created a dedicated topic.

Acceptance criteria:
- Do not condition button visibility on the existence or count of TODO run topics.
- The button remains clickable when there are no run topics; selecting it shows a clear empty state rather than hiding the entry or displaying ordinary chat topics.
- Clicking again returns to the ordinary topic list, preserving existing filtering behavior.
- Add regression coverage for zero run topics and for existing run topics.

Scope: button visibility and the empty filtered view only; do not migrate historical Awareness records or change scheduling behavior.
