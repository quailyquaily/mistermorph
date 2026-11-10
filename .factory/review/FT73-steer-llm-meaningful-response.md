---
branch: factory/FT73-steer-llm-meaningful-response
round: 1
---
# Handle every steer command or message through the LLM with a meaningful response

## factory · 2026-11-10 22:30
Owner request:
> new feature request: for each steer cmd or steer message, the agent need to handle it via llm and give a meaningful response. replace the emoji only response.

Add to new/ as a feature request; implementation has not started.

Acceptance criteria:
- Every accepted steer command or steer message is processed by the LLM with the relevant conversation and active-task context, rather than handled solely by a fixed emoji acknowledgement.
- Return a meaningful, user-visible textual response addressing the specific steer input (for example, how the request changes the ongoing work, an answer, or a necessary clarification). An emoji-only response does not satisfy this requirement.
- Preserve steering of the active task; a response must not replace or silently discard the requested steering. Do not claim work is completed merely because steering was received.
- Ensure each accepted input is accounted for when multiple steer messages arrive while work is running; avoid lost inputs and duplicate replies.
- If processing fails or steering cannot be applied, show an explicit failure or limitation rather than an emoji-only acknowledgement or a false success.
- Cover both command and message entry paths, active-task steering, successive inputs, and failure handling with regression tests.

Scope: replace emoji-only steer responses; do not remove unrelated emoji reactions elsewhere.

## factory · plan · 2026-11-11 00:58
Behaviour: validate empty and unavailable steering explicitly; preserve active-task input delivery and ask_user answers while generating a meaningful contextual LLM response for each accepted input. Account for successive inputs in order, failures and task-finish races. No first-run configuration required.
Scope: shared runtimecontrol responder, channel and command entry paths, local chat and Console presentation; leave unrelated emoji reactions unchanged.
Decisions: reuse configured model and task/history context; response generation has no tools or other side effects and must not imply completion. Bound concurrency and provide explicit limitations instead of false success.
Checking: mock-model coverage for context, command/message paths, successive inputs, exactly-once delivery, unavailable/empty input, model errors and emoji output, cancellation/finish races and ask_user compatibility; full Go checks and Console checks.

## factory · 2026-11-11 00:58
Built and pushed commits 6c90beb9 and 639735ca (head 639735ca). Shared tool-free contextual model responder replaces steer-only emoji acknowledgements across Console, local chat and supported user-facing channels. Actual steering remains queued. Replies are serialized per conversation, bounded to four concurrent model calls with 60-second timeout and a 32-message waiting limit. Failures and unapplied inputs produce explicit notices. Console displays each steer reply under its input. No new configuration.
Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with throwaway HOME. Coder also passed repeated targeted race tests, `nsh check`, 253 core Node tests, 524 nsh tests and the two new chat-steer tests separately.
Installs: none.
Not checked: live browser, desktop or Android UI; live model/provider and per-channel end-to-end delivery. Channels lack progress snapshots; Console late follow-up notices require history refresh. Agent Link late replies retain silent steering. Review should check these boundaries against the request, lifecycle races and UI ordering.
Verification: both commits are scoped to this item; no forbidden paths changed. Initial Git push credential-path failure was resolved with command-local credential.useHttpPath=true; no persistent settings changed.
Moved new/ → review/ for independent review; not shipped.
