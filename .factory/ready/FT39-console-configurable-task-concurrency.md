---
branch: factory/FT39-console-configurable-task-concurrency
round: 1
---
# Make Console task concurrency configurable instead of hard-coded to one

## factory · 2026-11-09 06:34
Requested by the owner in Telegram: add a factory issue because Console task concurrency should not be fixed at one. The owner also asked whether a global concurrency setting already exists.

Observed in cmd/mistermorph/consolecmd/local_runtime.go: the shared ConversationRunner receives make(chan struct{}, 1). A long-running task waiting for a coding tool occupies the only slot and prevents unrelated Console topics from starting.

Current configuration has per-channel *.max_concurrency settings (DefaultChannelMaxConcurrency = 3) and cron.max_concurrency (default 8), not a shared cross-channel task-concurrency setting. Console does not expose an equivalent setting.

Requirements:
- Replace the hard-coded Console task limit with console.max_concurrency, defaulting to the existing shared channel default (currently 3), rather than another literal limit.
- Preserve sequential execution within each conversation/topic while allowing independent topics to run concurrently up to the configured limit.
- Integrate the setting with normal config defaults, validation, settings exposure and runtime restart behavior; update assets/config/config.example.yaml and relevant English documentation. Document that this is a Console-local limit, not a process-wide shared budget.
- Handle omitted and invalid values consistently with existing channel settings. Explicitly setting 1 remains supported for users who want serialization.
- Verify concurrent Console tasks do not corrupt shared execution state, approval routing, workspace selection, streams or persistence. Keep changes focused; do not add a new process-wide scheduler in this issue.

Acceptance tests:
- Block task A in topic A on a simulated slow tool; topic B starts before A completes when the limit is at least 2.
- Active independent-topic executions never exceed the configured limit.
- Two tasks in the same topic remain ordered and never overlap.
- Completion, error and cancellation release slots; queued work can continue.
- Cover default, explicit override, invalid settings and runtime reconstruction/restart.

This item records a requested fix, not an implemented or deployed change.

## factory · 2026-11-09 06:33
Owner follow-up: all task-concurrency defaults should be 8. See FT40 in new/. This supersedes the earlier default of 3: console.max_concurrency must default to 8, preferably via the shared channel default updated by FT40. Preserve all other requirements and explicit overrides.

## factory · 2026-11-09 06:36
Owner requested merging FT39 and FT40, retaining only FT39. FT40's full scope is now part of this item; the earlier reference to a separate FT40 dependency is superseded. Implement both scopes together under FT39.

Consolidated additional requirements (formerly FT40):
- Set the shared channel task-concurrency default and every channel-specific task-concurrency default to 8; audit fallback paths for remaining defaults of 3.
- Keep cron.max_concurrency at 8 and verify omitted-value behavior. Console's new console.max_concurrency must default to 8 via the shared default rather than a separate literal.
- Preserve explicit user overrides, including 1, and existing invalid-value handling. Do not change deployment configuration or introduce a process-wide aggregate budget.
- Update assets/config/config.example.yaml and relevant English documentation consistently; do not modify config.yaml.
- Add regression tests proving omitted settings resolve to 8 across all task runners and explicit values remain effective.
- Acceptance: channels, cron and Console each default to eight simultaneous independent tasks, while preserving same-topic ordering and configured upper limits. Do not change unrelated concurrency settings such as network pools or tool parallelism.

All original FT39 concurrency, isolation, cancellation, configuration and restart requirements remain in scope. This is a board consolidation only, not implementation or deployment.

## factory · plan · 2026-11-09 08:09

Behaviour:
- On first run/omitted configuration, channel task runners and Console allow eight independent conversations; cron remains eight. Explicit positive limits, including one, win. Invalid values follow existing runtime fallback and settings-validation conventions.
- Console queues same-topic work serially through the existing ConversationRunner. Independent topics share a Console-local semaphore sized from console.max_concurrency; completion, errors and cancellation release capacity.
- Expose the integer setting with minimum one and runtime-restart application; reconstruct the runtime with updated capacity without leaking queued/running state.
Scope:
- Config defaults, runtime Console wiring, existing channel fallback audit, settings metadata, example config, English documentation, and regression tests. No deployment config, aggregate scheduler, unrelated tool/network concurrency, or gratuitous UI changes.
Decisions:
- Implement the consolidated FT39 scope (including all-channel defaults of eight); the current FT40 voice-input item is unrelated. Reuse DefaultChannelMaxConcurrency for Console, retain cron's existing eight.
- Preserve existing execution state and per-topic runner architecture; audit shared approval routing, workspaces, streams and persistence, fixing only concrete concurrency hazards required by this change.
Checking:
- Add deterministic blocked-task tests for cross-topic progress, upper bounds, same-topic ordering, error/cancellation capacity release, and concurrent task isolation. Cover omitted/default/explicit/invalid values and runtime reconstruction/restart.
- Run configured gofmt, go vet ./..., go test ./... with an absolute throwaway HOME; run targeted race checks for concurrency-sensitive packages. If Console sources change also run nsh check and nsh test --web-host tests/noHost.js.
- No interactive UI/browser testing is planned; report that limitation if UI changes.

## factory · 2026-11-09 08:09

Built and pushed commits b9f8ba24 (channel defaults) and 1d671c15 (Console configurable concurrency) on factory/FT39-console-configurable-task-concurrency.

- Console and channel task concurrency now default to eight through the shared channel constant; cron stays at eight. Explicit positive overrides remain effective. Audited fallback paths, including Telegram/Slack runtime-state fallbacks.
- Added console.max_concurrency settings metadata (integer, minimum one, runtime restart), Runtime capacity UI field, example config and English documentation. No deployment configuration changed.
- Console uses a resizable FIFO limiter retained across generations: automatic config reload also applies the limit without dropping queued/running work; lowering it waits for active work to finish. Existing channel runners retain fixed channel semaphores. Same-topic sequencing stays with ConversationRunner. Shutdown now drops jobs that acquired capacity concurrently with shutdown.
- Added defaults/override/invalid-value regression coverage across channel runners, settings validation/reset, runtime reload, blocked cross-topic progress, capacity bounds, topic ordering, task error/cancel/panic release, and concurrent workspace/context/history isolation. Coder audited approval routing, streams, persistence, execution state and per-task tools without identifying further required changes.
- Manager independently verified: test -z "$(gofmt -l .)" && go vet ./... && go test ./... passed; go test -race ./internal/channelruntime/core ./cmd/mistermorph/consolecmd passed; nsh check passed; nsh test --web-host tests/noHost.js passed (285/285). All scripted tests used an absolute throwaway HOME. Coder additionally reports repeated race/concurrency checks passing.
- Installs: none; nsh 0.4.0 was already available; no dependency manifests changed.
- Not checked: interactive browser/settings UI, live external channel services. UI changed and was not visually inspected.
- Existing limitations retained: stopping a task waiting for a runner slot takes effect once it starts; approval-paused work releases its slot, user-question waits hold it. Cron TODO tasks use separate scheduling even when they share Console topic keys.

Moved new/ → review/. Owner/reviewer should inspect the shared runner limiter/reload behavior and the new settings field. No merge or deployment performed.

## factory · review · 2026-11-09 08:18
head: 1d671c15829b2e5f935030826b3f5786bc5be391
verdict: pass

Codex reviewed origin/master...HEAD, including all 40 changed files and shared concurrency/isolation behavior. No verified introduced P0–P3 findings.

Validation reported by Codex:
- Configured gofmt check, go vet ./..., and go test ./... passed.
- go test -race for internal/channelruntime/core and cmd/mistermorph/consolecmd passed.
- nsh check passed; nsh test --web-host tests/noHost.js passed (285/285).
- All scripted tests used an absolute throwaway HOME. No installs, dependency restoration, code changes or commits; manager confirmed a clean worktree.

Residual risks: no interactive UI visual checks or live model, coding-tool, or external-channel integration checks. The coder could not locate its review-code skill/security reference, so no claim of completing that reference's security checklist is made.

Branch merges cleanly with the fetched master. Moved review/ → ready/ for owner approval; no merge or deployment performed. No linked GitHub issues or PRs to comment on.
