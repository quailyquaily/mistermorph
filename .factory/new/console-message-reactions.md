# Console Web: real message_react on user message bubbles

## lyric · 2026-11-03 18:09

Make message_react produce a real message reaction in Console Web, similar to Telegram: attach the emoji to the user's message bubble rather than sending it as a separate text message.

### Acceptance criteria
- Calling message_react in a Console conversation attaches the requested emoji to the corresponding user message bubble; it does not create a standalone emoji message or assistant reply bubble.
- Resolve the target from the calling task's originating user message, or a validated explicit message identifier if supported. A later user message arriving during execution must not redirect the reaction to the newest bubble.
- Show the reaction adjacent to or beneath the target bubble, in a compact Telegram-like presentation without obscuring message content.
- Persist reactions and restore them when the conversation reloads; update the active conversation without requiring a reload.
- Retried delivery of the same reaction does not create duplicate badges. Define and document how repeated calls with a different emoji update or coexist with an existing reaction.
- Reject nonexistent or unauthorized targets with explicit errors. Restrict targets to the authorized conversation; do not silently fall back to sending plain emoji text.
- Update the Console-facing tool description and result semantics to describe actual reactions rather than ordinary text delivery. Preserve existing behavior for other supported channels.
- Add regression coverage for correct target selection, concurrent/new incoming messages, live rendering, reload persistence, duplicate delivery, and invalid or cross-conversation targets.
