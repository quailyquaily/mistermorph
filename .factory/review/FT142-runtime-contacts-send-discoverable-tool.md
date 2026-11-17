---
branch: factory/FT142-runtime-contacts-send-discoverable-tool
round: 3
---
# Ordinary runtime: discoverable contacts send tool

## factory · 2026-11-17 18:45

Owner request:
> Add a tool for sending messages to ordinary contacts in the ordinary runtime as well. Do not provide it by default, but allow it to be found through tool search.

Scope and acceptance:
- Provide a contacts-send capability for ordinary human contacts in the ordinary runtime, not just Agent messaging or Console-only functionality. Inspect and reuse existing contact resolution and delivery infrastructure where available; confirm the canonical tool name during implementation.
- Keep this tool out of the default tool set supplied to the model. Register it in the searchable tool catalog so `tool_search` queries such as `contacts send` and the canonical tool name discover it, and the discovered tool can be invoked normally.
- Describe target identifiers, required message inputs, supported delivery routes, and errors accurately in the tool schema/help. Resolve recipients using existing contact identifiers; do not silently substitute another recipient or channel.
- Preserve existing permissions, recipient restrictions, credential handling, and delivery safeguards. Discovery must not bypass authorization, and unsupported or unreachable recipients must return clear failures rather than claim successful delivery.
- Add regression coverage for absence from the default tool set, discovery via tool search, invocation after discovery, successful delivery through the existing delivery path, and invalid/unsupported recipients or delivery failure.
- Keep existing `contacts_list` and `agent_send` behavior unchanged; this request is not an instruction to send any message now.

Requested status: new. Investigation and implementation are pending.

## factory · 2026-11-17 18:46

Owner clarification: "Ordinary runtime" includes Console, Telegram, Slack, and similar regular conversation runtimes. It does not mean only a CLI/headless runtime or only Console.

- Make the contacts-send tool searchable and callable after discovery in Console, Telegram, and Slack runtimes, while keeping it absent from each runtime's default model-visible tool set.
- Check registration and discovery/invocation coverage across those runtimes; do not implement this as a Console-only capability. Preserve the existing delivery and authorization safeguards in every runtime.

## factory · plan · 2026-11-17 19:09

Behaviour:
- In ordinary Console, Telegram, Slack and other shared runtimes, enabled contacts_send is available to the searchable catalog, absent from the initial model-visible tool set, and callable after discovery by contacts send or contacts_send.
- Reuse existing ContactsSendTool, contact resolution, delivery routing and runtime restrictions; invalid, unreachable and blocked recipients fail clearly. Disabled tools stay unavailable. Preserve awareness/cron behavior and contacts_list/agent_send semantics.
- Check first-run catalog preparation and tool-search-disabled behavior explicitly; ordinary runtime must not expose the send tool by default even when search is disabled (omit it if necessary).
Scope:
- Shared static registration, deferred tool/catalog integration and focused regression tests across Console, Telegram and Slack runtime wiring; help/schema only where needed for accuracy. No UI or new delivery backend.
Decisions:
- Canonical name is existing contacts_send; do not invent a second send tool. Use existing deferred tool infrastructure rather than a parallel catalog. Preserve all authorization, recipient and credential safeguards.
Checking:
- Regression tests for ordinary registration, default visibility, both search queries, invocation after discovery via existing sender, disabled config, runtime recipient blocks, invalid/unsupported recipients and delivery failure; verify Console/Telegram/Slack wiring.
- Run repository gofmt check, go vet ./..., go test ./.... No UI changes planned; no live outbound messaging tests.

## factory · 2026-11-17 19:09

Implemented the existing contacts_send as a search-only tool in ordinary runs through shared taskruntime preparation, covering Console, Telegram, Slack and other regular runtimes. Both contacts send and contacts_send searches discover it; post-discovery calls use existing contact resolution and delivery. Added runtime wiring, discovery/invocation, disabled configuration, recipient-blocking and failure regression tests. Updated English tool documentation and config comments.

Decisions: omit ordinary contacts_send when tool search is disabled; preserve existing explicit $contacts_send activation, awareness/cron visibility and contacts_list/agent_send semantics. No delivery or authorization implementation replaced. Existing accepted:false delivery-failure responses are retained.

Commits: 8d4b0771, bf758627, 5af46708. Head: 5af46708.
Installs: none beyond restoring pinned Go modules. No manifest/lockfile changes.
Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with a throwaway HOME under the run's TMPDIR.
Not checked: no live outbound sends; Slack and other routes rely on runtime wiring and existing sender tests. No UI sources changed; no visual inspection needed. Translated documentation remains unchanged.
Push initially failed because credential lookup omitted the repository path; retry with command-local credential.useHttpPath=true succeeded.
Moved new/ → review/ for review; not merged into master.

## factory · review · 2026-11-17 19:28
head: 5af467084dc1940d29d076072eb9dbf9a031bb52
verdict: pass
notes:
- [P2] internal/channelruntime/taskruntime/runtime.go:886-897: searchableStaticToolTriggers restores contacts_send when channel group-chat registries deliberately removed it. Example: a Telegram supergroup run removes the tool in buildTelegramRegistry, then prepareRun re-registers it as deferred, allowing tool_search discovery and sending without explicit $contacts_send activation. Preserve the channel group-chat restriction when adding the searchable trigger and add group-chat regression coverage. Equivalent group registry removals exist in Slack and other channels.

Reviewed by Claude Code against origin/master...HEAD (merge base cf3cb576), all 14 changed files. No P0/P1 findings; P2 remains for the owner to inspect before shipping.
Validation: required `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed with isolated temporary HOME and Go cache. Worktree remained clean; no review commits or code changes. Installs: none beyond existing pinned modules.
Limits: no live outbound sends, no end-to-end deferred-tool guard approval resume, no CLI/embedding execution. Console UI sources unchanged; UI checks not applicable. Existing delivery tests and fake Telegram API covered sending; other routes checked through shared wiring and existing tests.
Moved review/ → ready/ under the no-P0/P1 review rule; not merged into master.


## factory · review · 2026-11-17 21:17
head: 5af467084dc1940d29d076072eb9dbf9a031bb52
verdict: fix
fix:
- [P1] internal/channelruntime/taskruntime/runtime.go:886-897: searchableStaticToolTriggers re-registers contacts_send after Telegram/Slack/Discord/LINE/Lark/Mixin group registries deliberately remove it. Preserve the explicit group-chat activation restriction and add regression tests across channels.

Shipping assessment by Claude Code reproduced search followed by a successful fake Telegram send to another contact on this head, versus tool unavailable and zero sends on master cf3cb576. ForbiddenTargetIDs only blocks current-sender targets; no text-send guard restores the missing group activation gate. This violates the request to preserve recipient restrictions. Existing explicit $contacts_send activation was already available; this is loss of explicit opt-in, not an owner-only authorization bypass. Supersedes the previous P2 severity/pass assessment.

Not merged or tagged; branch unchanged, remains in ready/ pending correction/owner disposition. No fix applied during shipment. FT143–FT145 shipped separately in v0.3.117 without FT142. Reproduction and assessment logs retained in the shipment logs.

## factory · 2026-11-17 21:27

Owner requested: "fix FT142 by using claude code". Reopening for fix round 2 on the existing branch, addressing the latest P1 group-chat activation finding.

## factory · plan · 2026-11-17 21:39

Fix round 2: preserve each channel's existing group-chat explicit activation gate in shared deferred registration; keep direct-chat/Console discovery and explicit $contacts_send activation intact. Add actual task-entry regression coverage across Telegram, Slack, Discord, LINE, Lark and Mixin for unactivated group discovery/calls blocked with zero sends, explicit activation allowed, and direct-chat deferred discovery allowed. Use local fake delivery only; no UI changes or live sends.

## factory · 2026-11-17 21:39

Claude Code fixed the latest P1 by passing each channel's group restriction into shared run preparation as ContactsSendOptIn, suppressing automatic searchable registration when explicit activation is required. Existing explicit activation and channel triggers still work. Added cross-channel task-entry regression tests and English documentation; direct-chat and Console discovery remain covered.

Merged origin/master without conflicts (7d69b0b3). Fix commits: 66bcf705, 4c024fcc, 028e85ee. Head: 028e85ee. Branch pushed.
Validation: Claude Code passed the full gate, and manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with isolated HOME and TMPDIR. Worktree clean; no protected paths changed. Installs: none.
Limitations: no live outbound messages; tests use local fake Telegram delivery and injected runtime dependencies. Public-post Bluesky/X behavior unchanged. No UI changes or visual checks. Review of this new head is pending; previous head's review is not valid for this head.
Moved new/ → review/ for another review. Not merged into master or released.


## factory · review · 2026-11-17 21:52
head: 028e85eeef783acc76d079a6422a9e60eeaf4044
verdict: fix
fix:
- [P1] internal/channelruntime/socialpost/runtime.go:363-371: public Bluesky/X mention tasks omit ContactsSendOptIn, so shared prepareRun automatically registers searchable contacts_send without explicit activation. Set the public-thread opt-in flag and add regression coverage. Example: a public mention from did:plc:stranger with no $contacts_send can search for contacts_send and deliver one accepted fake Telegram send to tg:1001 on this head; origin/master delivers zero. This violates the requirement to preserve existing explicit activation safeguards.

Claude Code reviewed all 27 files in origin/master...HEAD, base b054491a; the six-channel group restriction fix holds, but the shared socialpost runtime remains exposed. No other verified findings. Required `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed (163 packages ok, zero failures), with isolated HOME/cache under TMPDIR; go.mod/go.sum and worktree unchanged. Reproduction used scratch copies and local fake delivery only, comparing this head against origin/master. Installs: none.
Limits: no live outbound messaging or end-to-end guard approval resume. Console sources unchanged in reviewed range; UI checks not applicable.
Moved review/ → new/ for fix round 3 (round 2 of max 3). Not merged into master or released.

## factory · plan · 2026-11-17 22:09

Fix round 3 — Behaviour: public Bluesky/X mention tasks preserve explicit $contacts_send opt-in. Without activation, discovery and calls cannot send; with activation, existing permitted delivery and forbidden-author restrictions remain.
Scope: shared socialpost RunRequest opt-in flag, actual task-entry regression tests for both channels, and English documentation/comments. No new sender, UI or authorization system.
Decisions: reuse ContactsSendOptIn; retain direct-chat/Console discovery and all six group gates. Invalid/empty recipients, disabled config and tool-search-disabled behavior remain unchanged.
Checking: no-activation discovery/call blocked with zero fake sends; explicit activation permits one fake delivery to another contact, but never to the public author. Run full formatting, vet and test gate with isolated HOME/TMPDIR.

## factory · 2026-11-17 22:09

Claude Code addressed the latest P1 by setting ContactsSendOptIn for public socialpost tasks. Added Bluesky/X task-entry regression coverage using local fake delivery, including unactivated discovery/call denial, explicit activation success and forbidden-author denial. Updated English docs/comments. Existing ordinary discovery and group opt-in regression tests still pass.
Commits: 59452980, 9cbf09e0. Head: 9cbf09e0. Branch pushed. No merge needed: local origin/master b054491a is already an ancestor.
Validation: coder and manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` with isolated HOME and temporary files. Worktree clean; changed-path inspection found no protected paths changed. Installs: none; no manifest or config-key changes.
Limits: no live outbound messages or end-to-end guard approval resume. Public runtime tests exercise shared socialpost.Run with Bluesky/X channel values, not external platform APIs. No UI changes or visual inspection.
Process exception: coder reported running `git fetch --dry-run` despite the no-fetch instruction; no ref updates reported. Manager handled the actual push.
Moved new/ → review/ for round 3 review; this head is not reviewed, merged into master or released.
