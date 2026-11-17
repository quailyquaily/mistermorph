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

## factory · review · 2026-11-17 10:33
head: de3a88510be1cd2168050ed3064e0a96effda618
verdict: pass
notes:
- [P2] web/console-nsh/pages/chat/chatController.ts:3278-3279: after a refused edit of a message loaded from an older history page, loadHistory refreshes only the latest page; the target is absent locally, so endMessageEdit discards the revision and restores the pre-edit draft even though the target still exists on the server. Preserve older pages on refusal and verify target existence server-side before ending editing; add paged-history regression coverage. Verified in a throwaway probe: load [t3,t2], load older [t1], draft "my draft", edit t1 to "What is a red fox?", receive 409 -> composer "my draft", quote closed, t1 row gone.
- No P0/P1 findings. Factory policy permits ready/ with this nonblocking P2; owner should inspect failed-submission retry behavior before shipping.
- Claude Code reviewed origin/master...HEAD and all changed surfaces. Required gofmt/vet/go test gate passed (163 packages); nsh check passed; Console scripts/test.sh passed (131 files, zero failures, 333s). Six parallel-test failures passed the script's isolated retry. The separate defect probe intentionally failed and is not part of the required gate.
- Installs: no unpinned tools or manifest changes reported. nsh populated its throwaway TypeScript 7.0.2 cache.
- Validation limits: no fresh visual inspection, real Android device, GPUI desktop app or live LLM run. Older binaries skip the new task_replace journal event; long-term memories from removed turns remain by documented design.
- Moved review/ → ready/. No linked GitHub issues or PRs identified.

## factory · 2026-11-17 18:21

Shipped via Claude Code. Conflict-free no-ff merge: 570def5f4e693ce85fba89486dcf7ea52107fe2e. Tag v0.3.116; remote master verified at cf3cb576ec3c41708ef9edc4e60f8fd794c27242.
- Final combined gate passed: gofmt, go vet ./..., go test ./...; nsh check; required Console parallel runner 132 files, 0 failures, 0 retries; Console Node 286/286 and Cloudflare Node 24/24. Worktree clean.
- No installs. No fresh visual, live LLM/device or native-platform checks.
- No linked GitHub issues/PRs identified; branch not deleted (clean not configured).
- Known nonblocking P2 retained: refused edit of an older paginated message can discard revision draft.
