---
branch: factory/FT140-edit-user-message-and-restart-conversation
round: 1
---
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

## factory · plan · 2026-11-17 10:14

## Behaviour
- On an idle topic, each editable historical user bubble has a compact accessible Edit icon immediately before Copy. Starting editing saves the unsent composer draft, loads that message, and displays its original text in a one-line ellipsized quote bar with Cancel at the right.
- Cancel/Escape restores the prior draft without persistence or generation. Empty/whitespace edits are rejected. Switching topics safely exits editing without leaking text across topics.
- On Send, the server validates topic, target message and idle status and durably replaces the target, removing every subsequent turn from both displayed and model history before generating from the prefix plus replacement. Submission errors retain the original history and editable text for retry. Reload sees only the accepted replacement and its new continuation.
- Reject conflicting edits/sends while generation is active, including server-side checks, rather than stopping active work implicitly. Guard concurrent requests and obsolete targets.
## Scope
Console chat components/controller/API types, daemon topic submission/storage/runtime context construction, and focused regression tests. No retained branches, unrelated refactors or changes to other transports. Preserve earlier turns and attachment semantics; inspect existing attachment handling and choose a safe, documented default for edited messages.
## Decisions
Reuse existing topic/message identity and submit pathways where possible. Introduce an explicit edit target, not destructive client-only filtering. Persistence is the acceptance boundary; do not delete old history on a validation or persistence failure. Handle legacy history/cached context consistently. An empty or missing topic has no editable target and returns an ordinary validation/not-found error.
## Checking
Test latest/earlier edits; target ownership/not-found; blank content; cancellation/draft restore; submission failure/retry; concurrent active-generation rejection; persisted truncation and reload; exact model prefix without stale following turns. Run configured Go gate, nsh check, and Console scripts/test.sh. Verify compact Edit/Copy order, one-line long quote and right-side Cancel at mobile/desktop sizes with keyboard and accessible labels, using available UI tooling; report explicitly if visual inspection unavailable.

## factory · 2026-11-17 10:14

Built in bc623174 (server), 7ab7b7c1 (Console), de3a8851 (docs).
- New POST /tasks/{id}/replace atomically journals replacement and removal of subsequent tasks. Reload/shared journal readers and future prompts use only kept prefix plus revision. Reset coder sessions; expire checkpoints covering removed turns.
- Compact accessible Edit immediately before Copy; one-line quoted original above composer with right-side Cancel. Cancel/Escape/topic switch restores prior draft. Failed submission retains edited text and original history until acceptance. Empty content rejected. Target highlighted; following rows faded.
- Defaults: reject queued/running/pending generation with 409, never stop implicitly. Keep and revalidate original attachments; disable adding attachments during edit. Commands except /think and Agent Link/TODO/Awareness topics are not editable. Unsupported runtimes return 404.
- Caveat: if a failed request is followed by reload where the target disappeared (concurrent replacement or accepted replacement whose run failed to start), editing exits to the prior draft and does not retain revision text. Existing long-term memories are not undone. Review should examine this exception against failed-submission acceptance.
- Installs: none; existing nsh 0.5.1 and playwright-core used.
- Manager independently passed configured gofmt/vet/go test gate. Coder passed nsh check, required scripts/test.sh (131 files, 0 failed, 246s), helper tests (5/5). Initial UI inventory failure fixed and full suite rerun clean. Tests cover latest/earlier/first edit, atomic failures and active generation, stale target, persistence/reload/shared journal, regeneration context/checkpoints, route wiring, drafts/cancel/retry/empty edits, attachments and topic switch.
- Coder inspected headless Chrome screenshots at desktop 1280x800 and touch phone 390x844: Edit/Copy order, compact single-line quote and right Cancel, keyboard focus/Tab and Escape. Open tooltip consumes first Escape; next cancels edit.
- Not checked: real Android device, GPUI desktop application, live LLM end-to-end. Regeneration prompt verified at Go engine level.
- First branch push credential request lacked repository path; one retry with per-command credential.useHttpPath=true succeeded. No user git settings changed.
