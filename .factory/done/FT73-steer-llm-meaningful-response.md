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

## factory · review · 2026-11-11 01:13
head: 639735ca2cb1d2ae4235217c03218a51f2a82545
verdict: pass
notes:
- [P3] internal/runtimecontrol/steer_responder.go:191: a ticket dropped during reply delivery gets no not-applied follow-up because the watcher is started only for pending tickets. Verified with an overlay test whose delivery callback finishes the lease: only the initial promise arrives. Start the watcher for dropped tickets too, or send their notice immediately, and add this regression test.

Reviewed by Claude Code: origin/master...HEAD, base 2b4c2ee1, all 42 changed files. No P0/P1 findings. Clean worktree and unchanged reviewed head confirmed by manager; branch merges cleanly with fetched base.
Validation: required gofmt, go vet ./... and go test ./... passed (162 packages); nsh check passed; nsh test --web-host tests/noHost.js passed all 526 tests. Scripted tests used a throwaway HOME. Targeted delivery-race probe reproduced the P3 above; it is not a failure of the required suite.
Installs: none.
Residual risks: live model/provider, per-channel delivery and desktop/Android UI not exercised. Console late notices need history refresh; concurrent inbound Respond calls do not guarantee original arrival order. Review passes the configured P0/P1 gate, not a claim of zero defects.
Moved review/ → ready/; not shipped. Owner should inspect the delivery-race note and live UI/channel behavior.

## factory · 2026-11-11 14:11

Owner-authorized ship with tag. Merge: e41edbcf46a0969cc5e1f3500240ca9c96e69ffd. Released in v0.3.96 at e41edbcf46a0969cc5e1f3500240ca9c96e69ffd; manager atomic push and remote master/tag verification succeeded.

Fixed dropped-during-delivery missing follow-up in 58ff29d0d2e25fe7ada6d52216a0b53d36abda70; deterministic regression fails before and passes after. Repeated race regression passes 20/20; applied/stopped inputs retain correct behavior. Updated feature branch pushed by manager.

Final read-only review: no P0–P3 findings. Combined validation: gofmt/vet/go test passed (162 packages), nsh check passed, full nsh suite 621/621, core Node tests 262/262 and manifest tests 6/6, steer race checks 220/220 and runtimecontrol race x3, web build passed. Scripted tests isolated HOME/XDG/TMP/cache. No installs. Initial Node PATH failure corrected using existing install.

No physical Android/emulator/native app or visual validation; Android build/host tests not run. No live model/channel verification. Console late notices still need history refresh; simultaneous replies may not preserve arrival order. Underlying nsh lifecycle limitation remains. No deployment.

Linked issues/PRs: none declared in header or owner sections; none closed. FT80 unchanged. Moved ready/ → done/.
