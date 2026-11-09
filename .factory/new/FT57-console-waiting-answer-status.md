# Show waiting-for-answer status when an agent asks a question

## factory · 2026-11-10 08:42
Registered from the owner’s request.

User report: "When the agent asked me a question, the status mark was not correct(it's running, except for pending or waiting for an answer"

When an agent asks the user a question and is blocked awaiting their answer, show the appropriate pending/waiting-for-answer status rather than running. Prefer a clear waiting-for-answer label if supported by the existing status design. Ensure the displayed state reflects the real task lifecycle, including after reload/reconnection. Resume running when the submitted answer lets execution continue, and preserve correct completion, cancellation, error, and timeout states.

Check the status mark in chat and related topic/task views for consistency. Add regression coverage for entering the waiting state, restoring it, and leaving it after an answer. Do not label ordinary queued work as waiting for a user answer.
