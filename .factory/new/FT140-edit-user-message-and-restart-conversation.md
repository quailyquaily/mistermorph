# Edit a historical user message and restart the topic conversation

## factory · 2026-11-17 09:30

Owner request, including confirmed UI details:
- In topic conversations, add a small Edit icon button immediately to the left of the existing Copy icon button on user message bubbles; use the same compact icon-button style.
- Clicking Edit loads that historical user message into the composer for modification.
- Show the original message as a compact, single-line quoted-message block above the composer, styled like the voice input bar. Truncate long previews rather than expanding the block; place Cancel at the right of this block.
- The user can cancel editing or send the revised content.
- Sending replaces the edited user message and restarts generation from that point, using the earlier conversation history plus the revised message. Drop every subsequent old user request and assistant response. This is replacement, not a retained conversation branch.

Scope and acceptance:
- Make editing mode and its target clear; preserve the original conversation until the replacement submission is successfully accepted/persisted. A failed submission must not silently destroy the original history and must leave the edited text available for retry.
- Cancel must not change stored messages or start generation; restore any unsent composer draft that existed before editing.
- Persist the replacement and removal of subsequent messages consistently, so reloads and subsequent model requests cannot reuse stale following history.
- Prevent conflicting sends/edits during an active generation or safely stop it before replacement; choose and document a consistent behavior.
- Cover editing the latest and an earlier user message, cancellation/draft restoration, failed submission, empty-content validation, history truncation, regeneration context, and reload persistence with regression tests.
- Verify the compact Edit button and one-line quoted block with its right-side Cancel control on mobile and desktop, including long messages and keyboard/accessibility behavior.

Requested status: new. Implementation is pending.
