---
branch: factory/FT182-contacts-send-file-to-current-user
round: 1
---
# Let contacts_send send a file to the person in the current conversation

## factory · 2026-11-24 22:26
Owner request: “remove the limition of contacts_send, which doesn't allow to send file to the current user.”

`contacts_send` refuses any send whose `contact_id` or `chat_id` is the counterpart of the current conversation: `tools/builtin/contacts_send.go:185` (single recipient) and `:290` (`checkContactsSendPlanBlocked`, batches), with `contactsSendBlockedTarget` in `tools/builtin/contacts_send_context.go:61`. The policy flag is `blockCurrentConversation` in `contactsSendPolicy` (`contacts_send.go:163`). Each channel runtime fills `ContactsSendRuntimeContext.ForbiddenTargetIDs` with the current counterpart (telegram, slack, discord, line, lark, mixin `runtime_task.go`; `accountdm/task.go:129`; `agentlink/runtime.go:399`; `socialpost/runtime.go:332`). So when the user asks the agent to send them a file, the call fails with "contacts_send blocked: … matches current conversation counterpart".

1. A send that carries a file (`path`) to the current conversation's counterpart goes through, by contact_id or chat_id, alone or in a batch, with or without a caption. It is delivered like a file to any other contact (same size limits, path roots, audit).
2. A text-only send (`message_text` / `message_base64`, no file) to the current counterpart stays blocked as today: the agent's own reply already carries text, and the block keeps it from answering twice.
3. The block's error for a text-only send says why and points to the alternative: reply in the conversation, or pass `path` to send a file there.
4. Update the tool's description (`contacts_send.go:76`) so the model knows a file may be sent to the current user, and a text message may not.
5. Social posts (`socialpost`): with `$contacts_send` in the post, a file to the post's author is allowed like any other file send; a text-only send to the author stays blocked (`internal/channelruntime/runtimetest/contacts_send_optin.go`, "public post with $contacts_send to its author").

Acceptance criteria:
- `go test ./tools/builtin/... ./internal/channelruntime/...` pass, with new cases: a file to the current counterpart by contact_id and by chat_id is sent; a batch including the counterpart with a file is sent; a text-only send to the counterpart is still refused with the new message.
- The existing tests that expect the block (`tools/builtin/contacts_send_test.go:127`, `:145`, the opt-in runtime test) still hold for text-only sends.
- `go vet ./...` and `go test ./...` pass.

## factory · plan · 2026-11-24 23:00
Behaviour: A successfully parsed file bypasses current-conversation blocking for single and batch sends, by contact_id or chat_id, with or without a caption. Text-only sends remain blocked with guidance to reply normally or pass path. Invalid files fail existing validation; public-post opt-in remains required.

Scope: contacts_send guard sites, error, description and docs, builtin delivery regressions and social-runtime regressions. No runtime forbidden-target changes, agent_send behaviour changes, new channel capabilities or UI changes.

Decisions: use parsed file != nil, not the raw path, for the exemption. Preserve the counterpart-identifying error text. Unsupported social file delivery must reach its existing channel error, never bypass channel restrictions.

Checking: real fake-API file delivery for contact_id/chat_id and batches, captions/no captions, invalid/empty path, text/base64 refusal, and social-author file guard bypass. Run focused packages, gofmt, vet and full suite.

## factory · 2026-11-24 23:00
Built e6d2dadbd20c1e3bd0a3a7c409058c89d0bca8e3 and pushed the item branch. Single and batch files can target the current counterpart; text-only sends remain blocked with actionable guidance. Updated tool description and English docs, added builtin and public-social regression coverage.

Tests: focused `go test ./tools/builtin/... ./internal/channelruntime/...` passed. Configured gofmt check, `go vet ./...` and `go test ./...` passed; manager independently repeated the full gate with isolated HOME, XDG directories and Go caches, all passed.

Installs: none beyond restoring pinned Go dependencies. No UI changes. Not checked: live channel delivery; fake API and runtime tests cover the changed behaviour. Bluesky/X files still have the same unsupported-channel limitation as any other recipient.

Moved new/ → review/, round 1. Initial branch push needed command-local credential.useHttpPath=true; retry succeeded without changing user settings.

## factory · review · 2026-11-24 23:05
head: e6d2dadbd20c1e3bd0a3a7c409058c89d0bca8e3
verdict: pass
notes:
- [P2] tools/builtin/contacts_send.go:187: File sends to the current Agent Link counterpart bypass its no-new-message guard, but contacts_send does not attach files to the pending reply. A verified probe with incoming hop 1 and a forbidden mm: asker delivered a new non-reply message at hop 2 with one attachment, while reply attachments stayed empty; master blocked it. This can restart agent tasks and permit file-response exchanges until max_hops. Route these files through the reply-attachment path, or retain the mm: counterpart block and direct callers to agent_send. The batch guard at line 292 has the same issue.

Validation: Claude Code reviewed all four changed files against origin/master...HEAD and the request/plan. Gofmt check, go vet ./... and go test ./... passed (168 tested packages). The Agent Link probe ran against both head and master in scratch copies. No P0/P1 findings; per factory policy moved review/ → ready/ with the P2 retained for owner attention. Live channel delivery was not checked. No installs. Repository working tree stayed unchanged. Harness output was written outside dir under /tmp/claude-995/; recorded for later owner-approved cleanup.
