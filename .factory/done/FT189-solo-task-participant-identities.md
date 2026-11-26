---
branch: factory/FT189-solo-task-participant-identities
round: 1
---
# Solo task chips and cards show participating subagents and coders

## factory · 2026-11-25 23:18
Owner intake, assessed by Claude Code; this is a request record, not an implementation report.

Original request: “Chip 和卡片，如果这次任务有 subagent 或者 coder 参与，应该在 chip 和卡片上也显示 subagent 或者 coder 的头像和名字。cc 看看合理吗？”

The owner authorized assessment and creation of a factory item, not implementation or shipment in this run.

Placement: backlog until FT188 (Solo chip details and mobile Back) ships. FT188 is currently ready and changes the same source collection, transport, parsing and chip files. This item is not a duplicate: FT186 introduced Solo, FT188 adds source-use details/navigation; neither adds task participants to Solo cards/chips. Move to new/ after that dependency ships, without reimplementing FT188.

## factory · plan · 2026-11-25 23:18
### Assessment and adjusted requirement
The design is reasonable for task-linked thread cards and chips, but not all provenance chips represent a task. Keep the task's main Agent separate from its workers: do not replace its identity or claim a participant owns the reply. No new main-Agent avatar is required; ordinary reply worker rosters already exist and remain unchanged.

- On Solo thread cards and their terminal summary cards, show a compact participant row reusing existing worker avatars, localized names and state marks. Show at most three workers, newest first, then +N. Hide the row if no participants are recorded. Preserve Open thread; do not add nested worker navigation.
- On the thread chip in the reply that started a work thread, show at most three small participant avatars and +N. Provide names and roles in the existing platform-supported tooltip/accessibility treatment, not visible full names in the narrow chip. This intentionally adjusts the literal request to avoid overflowing source chips; cards retain visible names. The chip's original label/navigation remain intact.
- Do not decorate topic/workspace/memory/journal chips. FT188 can classify a later read of a Solo thread as a thread chip, but it still identifies no single task; do not infer a roster from the topic's latest task.
- Join a starting chip to its exact task/card, never by title, model, backend or topic alone. If the card is outside loaded history or cannot be resolved, render the plain chip rather than inventing participants. No new fetch endpoint merely to decorate an old chip.

### Verified existing capability and data gaps
Read-only assessment on current remote master 3b5f3e98; FT188 branch inspected separately at b89fd5dd. References are to that assessed code and must be rechecked at build time.

- `internal/daemonruntime/solo.go:40-71`: SoloThread has no participants; SoloSource has kind/id/label. `internal/solo/sources.go:152-160` drops the work_thread task_id while keeping the topic/title; the tool already returns task_id (`internal/ownertools/threads.go:132`). FT188 adds uses[] and details, not participants.
- `web/console-nsh/components/chat/ChatSoloThread.tsx:43-85` renders the card without workers; `lib/core/solo.js:31-49` parses no participants. Reuse `ChatWorkerRoster.tsx:39-79`, `lib/core/chat-workers.js:52-101,197-207`, and `lib/core/worker-identity.js:209-240` rather than creating a second identity scheme.
- `agent/worker.go:19-31,115-125,184-218`: real spawn/coder invocations have allocated identities, unique within a task. Nested workers share that allocator. No parent relation is recorded: a direct-child-only filter is NOT currently supported.
- `cmd/mistermorph/consolecmd/activity_progress.go:24-76,763-771`: task activity retains newest 32 workers plus workers_omitted, with kind and status.
- `local_runtime.go:2531-2535,2651-2744` and `streaming.go:162-170,199,263-265`: live roster exists in task activity/latest stream frames; persisted result.activity.workers is available on terminal/pause paths. This is not a durable Solo-card participant projection today.
- `cmd/mistermorph/consolecmd/solo.go:260-316` syncs on task state transitions, not worker changes. `pages/chat/chatController.ts:3709-3723` already refreshes live Solo history every three seconds.

### Scope and simplest proposed implementation
These are proposed additions, not capabilities already present:
1. Add an optional bounded, identity-only participant projection and omitted count to SoloThread records and summaries. Reuse worker field semantics (id, name, name set/index, avatar index, kind, status); never copy prompts, outputs, messages, results or process/PID metadata.
2. Feed it from the task's real worker activity. Persist participant changes while running via the existing activity-updated path, only when the reduced projection changes, plus existing terminal/pause synchronization. Existing history/polling should suffice; do not introduce a new scheduler or subscription protocol. Avoid recursive update loops and output-chunk-driven history writes.
3. Add optional task_id to source chips that actually start a work thread, preserving FT188 uses[], source ordering and deduplication. Match those chips to loaded task cards in the Console. When existing source dedup folds multiple task starts into one topic chip, define a lossless task association or omit ambiguous decoration; never show a wrong task's workers. Cover this case explicitly in tests.
4. Deduplicate by (task_id, worker_id). Repeated events for one worker update it; separate coder calls remain separate named workers even with the same backend/model. Include descendants flat because parentage is unavailable. Do not build an organization chart or add parent tracking for this feature.
5. Preserve bounded roster semantics. With three visible entries, +N equals known retained workers not shown plus workers_omitted, without counting duplicate card/summary projections twice. Do not imply omitted identities can be listed when they were not retained.
6. Reuse existing worker-state normalization: preserve individually failed workers; normalize stale running workers against the owning task's terminal state. Running, waiting/approval, completed, failed and stopped/canceled tasks keep their actual recorded roster. Continued threads get separate per-task rosters.
7. Missing name/avatar metadata uses the existing ID-based deterministic avatar/name fallback, with kind-aware accessible labels. No invented person or arbitrary main-Agent avatar. Old cards/chips with no participant data stay unchanged, with no historical backfill claim. A restart cannot recover identities never recorded; preserve the last durable projection and normalize state where applicable.
8. EN/ZH/JA strings; maintain shared Console layout and interactions across web/native clients. No native-specific rendering claim without device/emulator checks.

### Acceptance criteria
- A task starting one subagent and one coder shows both identities and roles on its own card during execution by the next normal live-history refresh; its exact starting chip shows the corresponding avatars when the card is loaded.
- Worker completion/failure and later task completion update correctly. The terminal summary agrees with the card; a reload retains recorded participants and final states. Persisted projections survive runtime restart; missing historical data is not synthesized.
- No-worker and legacy data produce no new empty row. Missing/broken avatar or name data remains readable via shared fallback. Main-Agent and worker identities are never conflated.
- Duplicate progress events do not duplicate workers; separate invocations and nested workers remain distinct. Same-topic continued tasks do not leak participants across tasks. Ambiguous folded source associations do not silently select an unrelated task.
- More than three workers and more than 32 allocated workers yield correct +N; long/localized names and phone-width chips do not cause horizontal overflow. Complete names/roles remain accessible without relying on hover alone.
- Unrelated provenance chips and FT188 details/mobile Back behaviour remain unchanged. No raw output or PIDs enter the new metadata, no full activity payload is copied to cards, and unchanged participant state causes no extra durable writes.

### Checking
- Go unit/integration coverage: worker projection and bounds, safe field allowlist, live join/status callbacks, change-only writes, pause/terminal sync, restart/reload and missing task/legacy JSON; task_id source association, dedup and multiple starts into the same topic, preserving FT188 uses[].
- Console tests: card/summary identity consistency, both kinds, live-to-terminal states, stopped/failed/waiting, no workers, missing metadata/image fallback, nested/repeated workers, per-task isolation, overflow including omitted count, exact/ambiguous/missing loaded-card joins, untouched other chip kinds and FT188 interactions, accessibility and EN/ZH/JA.
- Required build gates: configured gofmt check, `go vet ./...`, `go test ./...`; `nsh check` in web/console-nsh and `web/console-nsh/scripts/test.sh`. Use isolated test HOME/cache rules.
- Manual web/phone-width check for layout, readable names and navigation; native device/emulator checks for avatar fallback and accessibility where available. Report unperformed checks explicitly.

Assessment validation: code/board inspection only, no implementation, builds, tests, installs or visual/device checks. Claude Code reported no file writes; assessment worktree remains clean.

Non-blocking follow-up for FT188 verification: code reading suggests `internal/solo/sources.go:114` ignores worker-tagged tool events, while real coder completion carries a worker (`agent/worker.go:209-218`); FT188's collector test uses an event without one. A real coder workspace-use count may therefore be absent. This is unconfirmed and not a reason to fabricate provenance; verify with a realistic event fixture during related implementation/review rather than silently expanding this item.

## factory · 2026-11-26 07:39
Owner authorized moving FT189 to new/. Moved backlog/ to new/ without changing the assessment, scope or acceptance criteria above.

Dependency update: FT188 is now in done/; its shipping record reports merge 12ab853ea955819a2daa2f4cd5928de845e37bba on master and release v0.3.137, pushed on 2026-11-26 at 07:09 Asia/Tokyo. The earlier hold until FT188 ships is therefore satisfied. Recheck the current code at build time and preserve FT188 behavior.

This change only queues the item. No build, review, implementation or ship was started by this intake action.


## factory · plan · 2026-11-26 08:15
### Behaviour
Project each Solo-started task's actual worker identities into its card and terminal summary. Refresh on identity/status changes through the existing activity callback, not every output chunk. Retain bounded roster and omitted counts, normalize stale running identities at task completion without erasing individual failure, and keep durable last-known identities across reload/restart. Cards display newest three names/avatars/states plus correct +N. Starting thread chips show three avatars plus +N with accessible names/roles only for an exact loaded task match. Empty/legacy/unresolved/ambiguous records remain plain; other provenance kinds unchanged.
### Scope
Implement the existing assessed requirement and tests across runtime projection, Solo transport/source association, Console parsing/joining and shared rendering. Preserve FT188 uses, source dedup/order, details and mobile Back. No new endpoint, scheduler, parent tracking, raw activity payload or nested worker navigation. Verify realistic coder event provenance fixture but do not expand into unrelated fixes.
### Decisions
Reuse worker identity localization/status/avatar helpers, flatten descendants because parentage is unavailable, retain newest bounded 32 and count omitted. Use an explicit optional task association; if dedup merges different starting task IDs, carry a lossless bounded representation or deliberately suppress ambiguous decoration. Never infer by topic alone. Existing main Agent identity remains untouched. Safe allowlisted metadata only. Isolate test HOME and all already-defined cache overrides.
### Checking
Add regression tests for live change-only projection/write triggers, terminal/pause/restart durability and state normalization, identity-only bounded metadata, repeated/nested workers, omitted counts; source exact/ambiguous association preserving uses; card/summary and chip rendering, accessibility/localization, no-worker/legacy/fallback/per-task isolation and FT188 behaviour. Run configured gofmt/vet/go test gate, nsh check and scripts/test.sh. Report any unavailable manual web/phone/native checks without claiming they ran.

## factory · 2026-11-26 08:15
Built at head 15536f1f (backend efdde58c), based on master 12ab853e. Cards/summaries retain bounded safe worker identity projections; existing activity changes refresh only changed participant state. Newest three localized identities and states appear on cards; starting chips show avatars only for exact loaded task/topic matches. Repeated starts folded into the same topic suppress ambiguous chip decoration. Missing historical data stays absent; descendants remain flat. Pause/resume merges durable workers rather than replacing them. FT188 interactions and uses preserved.

Installs: none; no dependency/manifest/config changes.

Tests: coder reports isolated gofmt/vet/go test gate passed (172 packages); manager independently reran the configured complete Go gate successfully. Coder reports nsh check passed and required Console script passed: 173 files, 0 failed (445s). Regression coverage includes runtime projection/retention/status/change-only writes, restart, source task association, and 8 Console participant tests.

Visual checks: coder reports inspecting real-component headless Chrome fixtures at 320/390px without overflow; 900px automated no-overflow check only. Not checked: full live Console, ZH/JA browser layout, dark scheme, manual tooltip, native builds or device screen readers. Headless locale tests passed; no native rendering claim.

Related non-blocking FT188 issue confirmed by coder's realistic engine probe: worker-tagged coder completions are excluded by SourceCollector, so real coder workspace-use provenance may be absent. Not changed here; review should inspect separately.

Process deviations: coder wrote a Claude memory file and a MEMORY.md line outside the permitted run directory; no such write was requested or accepted as feature work. Coder reports two early go test runs lacked TMPDIR, generated /tmp/TestSolo... folders then removed them; none remain. Manager before/after /tmp inventory found no new retained paths. No /tmp deletion performed. Existing legacy run-root files left untouched. Branch push initially needed credential.useHttpPath=true; the single retry succeeded. No base/tag push.

Move: new/ → review/, round 1. Owner should inspect participant identity isolation, durable pause/restart semantics, bounded +N and accessible phone-width chips in review.

## factory · review · 2026-11-26 08:24
head: 15536f1ff0732d1473351550dde03a485afde815
verdict: pass

Claude Code reviewed origin/master...HEAD (base 12ab853ea955819a2daa2f4cd5928de845e37bba; 17 files). No qualifying P0/P1/P2/P3 findings. Worktree remained clean, with no commits. Branch merges cleanly with the fetched base.

Validation by reviewer: configured gofmt/vet/full Go test gate passed (172 packages); nsh check passed; required Console scripts/test.sh passed (173 files, zero failures, 350s). Five unrelated Console files needed the script's automatic isolated retry and then passed. Additional Solo race tests passed in consolecmd, internal/solo and internal/daemonruntime. Tests used isolated HOME/XDG/cache settings. No installs.

Checked identity-only metadata allowlists, bounded worker retention and +N, change-only durable updates, pause/end/restart merge, individual failure preservation, exact task/topic chip association and ambiguous suppression, existing FT188 source uses/details/navigation, and EN/ZH/JA/accessibility labels.

Residual uncertainty, not confirmed defects: concurrent live activity readings may briefly arrive out of order; omitted counts on resumed tasks exceeding 32 workers with missed intermediate readings or resurfacing old workers were not reproduced. No live Console, browser phone-width/localized/dark layout, manual tooltip, native build/device or screen-reader checks in this review. Existing worker-tagged SourceCollector limitation predates this item and is unchanged.

Process note: reviewer reports the CLI harness wrote background-task output under its own temporary directory outside the run directory; exact file was not supplied. Manager's top-level temporary inventory showed no new entries. This path is retained in the outside ledger; nothing there was deleted. No memory writes reported in this review.

Move: review/ → ready/, round 1. Nothing merged, tagged or released. Owner should inspect live/device accessibility and the unverified high-worker-count resume cases before shipment.


## factory · 2026-11-26 09:55
Asked ship authorized by owner: “对，应该 ship”. This run selected FT189 only; no later ready items, new/review items, extra builds or reviews were included.

Shipped to master at merge 0fe6f3cdb05cadab904570ff66f3f8f198b14bb5, branch head 15536f1ff0732d1473351550dde03a485afde815. Annotated release tag v0.3.138. Atomic push of master and tag succeeded; remote master and peeled tag both verified at the merge commit.

Validation on merged base: affected Go package tests and Console participant tests passed; nsh check passed; configured gofmt/vet/full Go gate passed. First full Console run had one chat-attachments test fail even after its automatic isolated retry (composer send button covered). Baseline master passed that file. Re-merged the same item without code changes and repeated the full Go gate and required Console script: 173 files, zero failures (383s). No installs or dependency changes.

No linked issues/PRs were identified in the item, so none were closed. Branch retained: configured ship actions default to merge/tag/push, without clean. No manual live Console, phone/localized/dark browser, native device or screen-reader checks in this ship run; review's documented limitations and existing SourceCollector limitation remain.

Move: ready/ → done/.
