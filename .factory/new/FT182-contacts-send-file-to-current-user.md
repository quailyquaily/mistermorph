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
