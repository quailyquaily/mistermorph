---
branch: factory/FT2-console-message-reactions
round: 0
---
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

## factory · plan · 2026-11-03 19:59

**Behaviour:** Attach one reaction to the calling task's originating user bubble, not the newest message. Reject missing and cross-conversation targets. Persist and stream the reaction; repeated identical delivery is idempotent and a different emoji replaces the badge. Ordinary final text remains a separate reply when supplied.

**Scope:** Reuse the existing Console task journal, tool, WebSocket relay, polling and history rendering. Update Console API documentation and regression tests; leave other channels unchanged. Reuse the existing implementation rather than start another build.

**Decisions:** No explicit target identifiers are supported. One reaction per originating task; no new configuration. The keystore fixture fix is already identical to base.

**Checking:** Go formatting, vet and full tests; frontend regression tests and production build. Browser visual, live interaction and end-to-end agent checks require manual verification and an independent review job.

## factory · 2026-11-03 19:59

Reused and verified head `d18813f0ab2fe1f1d368905fd197a407dd2bd390`; pushed `factory/FT2-console-message-reactions` (remote was already up to date). Configured gate `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed with an absolute throwaway HOME and existing Go caches. Node v26.13.0 and pnpm 12.16.1 are available; existing frontend dependencies were reused without installation. `pnpm build` passed. Composer/reaction targeted tests passed 27/27. Full `pnpm test`: 306/308 passed; the two failures, “reasoning expands into the existing Markdown chat bubble” and “Skills sits after TODO in the navigation”, also fail on base `3682ff397104123d029a8c8728b2478506c928f6` (303/305 pass). These unrelated baseline failures were not changed.

A disposable merge with that base was conflict-free; the configured Go gate passed on merge commit `22aeab73d67f432925f1a1cdaf3629e0c2cbbf3d`. No feature was merged into master. Changed paths were checked against the forbidden-path list; no forbidden path changed. No new implementation or fix was needed, so recovery continued at Build step 5 without another coding-agent invocation.

The implementation and regression tests cover originating-target selection, later incoming messages, invalid/cross-conversation targets, persistence, idempotency/replacement, live updates and reload mapping. Actual browser layout and clipboard-independent conversation interactions were not checked. No authorized review has been recorded for this head; this item remains in review pending the separate review job, not ready. Full frontend-suite baseline failures remain visible for the owner.
