# Console topic temporary done status until viewed

## factory · 2026-11-05 11:17
Requested by the owner: “topic 的 running status，如果从 running 到 done 需要加一个临时的 done 状态，用户进入该 topic 以后，该状态移除”

Add as a new item; this records the request, not an implementation.

Requirements:
- When a topic transitions from running to successfully done, replace its running indicator with a temporary done indicator so the user can identify completed topics they have not viewed.
- Clear that temporary indicator when the user enters the corresponding topic. Do not change the actual task completion status or history.
- If the topic is already actively visible when completion arrives, treat it as viewed; do not leave a stale done indicator. A background browser tab is not an active view.
- A subsequent run takes precedence over a previous done indicator; acknowledging an older completion must not clear a new running state.
- Do not mark failed or cancelled tasks as successfully done, and do not mark all historical completed topics as newly unread on initial load.
- Cover running-to-done, entering a completed topic, completion while actively viewing, background completion, and a subsequent run in regression tests.

Keep this separate from FT14 browser notifications: this item concerns the topic status indicator.
