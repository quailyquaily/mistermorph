---
branch: factory/FT186-solo-mode
round: 3
---
# SOLO mode: one conversation, the agent arranges the rest (step 2)

## factory · 2026-11-24 23:30
Owner request (design agreed in conversation): “provide a SOLO mode so user will only talk in a solo topic, the agent automatically handle the task if the task require the data or info from different workspaces or other things (channels, topics, memory).” SOLO sits **beside** topics as a mode; it does not replace them. “we can still use different topics if need to arrange the things, and provide good feedback in the solo mode.”

**Move this to new/ only after FT185 (agent tools across topics and workspaces) has shipped**: it is built on those tools, and a build starts from `master`. It also benefits from FT184 (messages to a running subagent).

1. **The mode.** A pinned **Solo** conversation, always first in the Console's topic list, beside the ordinary topics; one per agent. Topics work as today.
2. **How a Solo message is handled.** The agent decides per message: answer inline; recall from memory, the journal or another topic (`topic_search`/`topic_read`); or work. Work that needs a workspace or runs long goes into a **work thread**: an ordinary topic the agent creates (or continues) with the right workspace attached, titled for the work and marked as started from Solo. The thread's task runs in the background; Solo stays free for the next message. Short work in a known workspace may run in Solo itself with a per-task workspace (FT185).
3. **Feedback in Solo.** Each reply shows, as small chips, the workspace it used and the threads and sources it touched (memory, journal, a topic). A thread the agent starts shows in Solo as a card: its title, workspace and state (running, done, failed), updated live, opening the thread when pressed. When a thread finishes, Solo gets its summary with a link. The user can open any thread and go on there; what is said there stays in the thread.
4. **Asking first.** When the workspace for a piece of work is unclear, the agent asks in Solo instead of guessing; the first write in a workspace follows FT185's approval.
5. **Context.** Solo keeps summaries and links (its compaction keeps them); the full working context stays in the threads. Memory grows from both as today.
6. **Who.** Solo is the Console owner's conversation. Channel conversations stay their own audiences.
7. **Clients.** Console on the web, the desktop app and Android (one TSX app, `web/console-nsh`): the pinned Solo entry, the chips, the thread cards, on phones too; strings in English, Chinese and Japanese. The terminal chat can open Solo (`/solo`, or its topic ID).

Acceptance criteria:
- A Solo message needing another workspace starts a work thread with that workspace, shows its card in Solo live, and posts its summary when done; Solo answers another message meanwhile.
- A Solo question about earlier work in another topic is answered from that topic, with a chip naming it.
- Ordinary topics work as before; Go and Console tests cover the Solo routing, the thread cards and the chips; `go test ./...` and the full Console test runner pass.

## factory · 2026-11-25 15:51
Moved to new/ at the owner's word ("sure. add to new/"), now that FT185 (workspace_list, workspace_use, topic_search, topic_read) has shipped in v0.3.134: build on those tools as they are on master rather than adding new ones.

## factory · plan · 2026-11-25 16:31
Behaviour
- Ensure one stable owner-only Solo conversation per agent, lazily on first use/listing, pinned before ordinary topics. Preserve existing topic behavior, channel audience isolation and permissions.
- Solo can answer inline or use FT185 workspace/topic tools. Add a minimal owner-only work-thread dispatch tool integrated with existing topic task submission, not a parallel job engine. It creates/continues an ordinary topic with explicit workspace, links it to Solo and submits background work so Solo remains usable. Ask when workspace is ambiguous; keep first-write approval.
- Persist origin/task links and durable completion summaries. Live cards show running/done/failed and navigate to thread; failures and empty outcomes get understandable summaries. Avoid duplicate summaries on polling/restart, don't leak channel/private audiences.
- Show compact provenance chips for workspace/topic/memory/journal actually touched, not guessed. Keep summary/link context across compaction. Ordinary thread conversation remains there.
- Terminal /solo opens the same stable conversation; clients share TSX and EN/ZH/JA strings.
Scope
- Backend topic/runtime/API and owner tools, shared Console chat navigation/cards/chips and terminal command, focused regression tests. Reuse current storage, task lifecycle and activity mechanisms. No channel conversation routing changes or new scheduler.
Decisions
- Use a reserved stable Solo identifier with per-agent existing storage isolation; validate existing topic constraints before choosing exact representation. Lazy idempotent creation for first-run/backwards compatibility.
- Agent selects dispatch explicitly from guidance/tool, never by brittle user-text keyword routing. Explicit workspace required for work dispatch; reuse FT185 validation/approval.
- Track actual task/tool events for source chips and thread updates; completion delivery must be durable and idempotent. Do not claim the UI was visually checked unless it was.
Checking
- Go tests for idempotent Solo, owner-only dispatch, workspace validation/approval, background concurrency, durable completion/failure/duplicate suppression, linked context and ordinary topic regressions.
- Console tests for pinned Solo, live cards/navigation, chips and translations, plus terminal /solo tests.
- Required gate: test -z "$(gofmt -l .)" && go vet ./... && go test ./... ; Console nsh check and scripts/test.sh. Run scripted tests in isolated throwaway HOME/XDG/cache variables; report manual UI not checked if unavailable.

## factory · 2026-11-25 16:31
Built and pushed at 78d0c47f (five focused commits from base 7eac7239). Moved new/ → review/.

Implemented one pinned owner-only Solo conversation, background work_thread dispatch with explicit validated workspace and first-write approval, persistent live thread cards and idempotent completion summaries, provenance chips from successful tool calls, recent thread context across compaction, EN/ZH/JA strings and terminal /solo. Existing topics and channel audiences remain separate.

Decisions: reuse normal topic/task storage and queue; completion summary is the first 1,500 characters of the thread reply/error, not another model call; cards refresh every three seconds while live. No new config keys.

Checks: manager independently verified gofmt, go vet ./..., go test ./... and nsh check pass. Full Console scripts/test.sh: 169 files, one failed after isolated retry: `tests/ui-components.test.tsx: cannot find role:button[Login]` (two assertions). Coder reproduced the same failure on base 7eac7239; left the unrelated failure unchanged. New Solo Go/runtime/terminal tests and Console card/chip/navigation tests pass.

Visual check: coder checked built web UI in Chrome with stubbed API at desktop English and phone-width Chinese; running-to-done cards, summary and navigation worked. Empty space below the card button remains cosmetic. Native desktop/Android/iOS packages and a live model end-to-end were not checked.

Installs: none; no manifest or lockfile changes. Shared Go build cache was written before the isolated test environment was applied. Coder also reported a Claude project memory note outside the permitted run folders; it is not part of the implementation, and no unrelated user files were removed. No new directly owned /tmp entries were observed by the manager.

Review should check owner/audience isolation, resumed-workspace approval, concurrent Solo/thread operation, durable once-only completion, and the existing Console failure before approval.

## factory · review · 2026-11-25 16:43
head: 78d0c47f1e83ab16fa708bfa6da88bf187d4c8ac
verdict: fix
fix:
- [P1] web/console-nsh/tests/ui-components.test.tsx:107,135: required Console scripts/test.sh fails after isolated retry: `cannot find role:button[Login]` (2 assertions; UI says “Log in”). Factory gate blocks approval even though both failures reproduce unchanged on base 7eac7239 and are not introduced by FT186. Do not fix unrelated baseline code on this branch; restore the required baseline gate before approval and rerun review.
notes:
- [P3] cmd/mistermorph/consolecmd/solo.go:469-474: read_file/write_file add a workspace provenance chip for /var/lib/morph_nest paths and absolute paths outside that workspace. Verified scratch probes: reading /var/lib/morph_nest/notes.md or /etc/hosts both produces the current workspace chip. Resolve paths against run roots and only label the actual workspace touched.
- [P3] web/console-nsh/pages/chat/chatController.ts:674: Solo is pinned only within loaded topic pages. Verified probe: EnsureSoloTopic followed by 100 CreateNamedTopic calls makes ListTopicsPage(Limit:100) omit _solo, so no pinned Solo appears initially. Include Solo in the first server page or fetch it separately.

Validation: Claude Code reviewed all 44 changed files / five commits in origin/master...HEAD. No merge conflicts with base. Required Go formatting/vet/full tests pass (171 packages). nsh check passes. Console scripts/test.sh: 169 files, one failed after isolated retry; same two Login failures reproduced on base. New Solo UI tests pass; additional lib node tests 319/319 pass. Worktree remains unchanged. Tests used isolated HOME/XDG/cache paths. No installs.

Residual risks (not confirmed introduced findings): restart completion catch-up scans only the latest 200 Solo records; editing earlier Solo messages removes later cards; thread reply excerpts enter Solo prompt without an explicit untrusted wrapper; local terminal Solo lacks Console work_thread/chips. No live-model end-to-end, native packaging, Android JVM or visual checks in this review.

Round 1 of max 3: review/ → new/ because the required test gate fails, not because a new P1 code defect was demonstrated. Owner should address the pre-existing baseline failure separately and inspect the two P3 findings. No linked GitHub issues or PRs. Claude harness reports temporary output under /tmp/claude-995; recorded in the outside inventory, not deleted. No newly observed directly owned /tmp entries.

## factory · plan · 2026-11-25 17:11
Round 2 addition. Behaviour: import the baseline Login-selector correction already on master by merging master, preserving Solo and upstream changes; restrict file-tool workspace chips to paths the built-in resolvers actually resolve inside the workspace; include Solo on the first Console topics page after more than 100 topics while keeping pagination complete and duplicate-free. Scope: latest review P1 and its two confirmed P3 findings only; no unrelated bespoke baseline fixes. Decisions: reuse file-tool path resolution rather than a second alias parser; preserve page-size-one store ordering to avoid dropping topics. Checking: regression tests for outside/nest/alias/escape/symlink paths and HTTP pagination across 106 topics with multiple page sizes; rerun all required Go and Console gates.

## factory · 2026-11-25 17:11
Round 2 built and pushed at de665864. Moved new/ → review/.

Merged master 49e236f6 without conflicts or rebase, importing its existing Log in selector correction and clearing the previous baseline P1. Added file-tool resolver-based workspace provenance and regression coverage (26 path cases), including symlink escapes; added first-page Solo pinning with complete HTTP pagination coverage at page sizes 100, 3, 2, 1 and 200 over 106 topics. Page-size-one keeps store ordering rather than pinning Solo, to avoid skipping topics. Updated English docs.

Checks: Claude Code ran gofmt/vet/full Go tests (171 packages pass, 19 without tests), nsh check and required full Console scripts/test.sh: 171 files, 0 failed, 255s, exit 0, no retries. Manager independently reran gofmt, go vet ./..., go test ./... and nsh check successfully. Manager checked commits and protected paths against current master: only this item's work and a master merge; no protected-path changes in the feature diff.

No installs or manifest/lockfile changes. Scripted tests used isolated HOME/XDG/cache variables; final HOME was made by mktemp -d and earlier isolated Go caches were moved into it. Offline Go module proxy read shared download cache without writing it. Recovered stale prior-run temporary files (read-only module directories required owner-write permissions before cleanup). No newly observed directly owned /tmp entries; Claude harness reported /tmp/claude-995, recorded in outside inventory, not deleted.

Visual UI, native Android/iOS/desktop and live-model end-to-end were not checked this round. Review should confirm the baseline blocker is cleared, resolver behavior and pagination edge cases; earlier residual risks remain for review. Branch push initially lacked credential repository context and succeeded on its single retry with per-command credential.useHttpPath=true. No linked GitHub issues or PRs.

## factory · review · 2026-11-25 17:21
head: de6658645a73fe5130fcd6ae429349d053c7a690
verdict: fix
fix:
- [P1] cmd/mistermorph/consolecmd/solo_test.go:662: the required Go test gate fails when TMPDIR is inside the isolated HOME. TestSoloSourceCollector expects an absolute workspace label, but production correctly abbreviates it to ~/... . Verified three times with HOME=$H TMPDIR=$H/tmp go test -count=3 -run 'TestSoloSourceCollector$' ./cmd/mistermorph/consolecmd/: actual Label:~/tmp/TestSoloSourceCollector…/001 differs from the expected absolute path. Use ownertools.DisplayPath(ws, workspace.HostHomeDir()) in the expectation. This is a test portability defect, not a production-label defect; factory policy treats a failing required test as P1 regardless of the coder's P3 classification.

Validation: Claude Code reviewed all 46 files in origin/master...HEAD, including round 2 and security-sensitive Solo ownership/workspace paths. No merge conflicts; worktree remains unchanged. Earlier Login blocker and both previous P3 fixes are cleared. gofmt and go vet pass. Full go test ./... fails only TestSoloSourceCollector when TMPDIR is under isolated HOME; full suite passes with TMPDIR outside HOME (171 packages pass, 19 without tests). nsh check passes. Required Console scripts/test.sh: 171 files, 0 failed after five isolated retries (chat-attachments, settings-agent-name-set, settings-page, settings-menus, dialog-sheet); 356 seconds. Additional Node library tests: 321/321 pass. All scripted tests used throwaway HOME/XDG/cache directories and a read-only Go module proxy. No installs.

Residual risks: restart catch-up scans only the newest 200 Solo records; editing earlier Solo messages removes later cards; thread reply excerpts lack an explicit untrusted wrapper; local terminal Solo lacks work_thread/chips; a cached first topic page can briefly omit old Solo until refreshed. These were not established as introduced blocking findings. Live-model end-to-end, visual UI, native builds and Android JVM tests were not checked.

Round 2 of max 3: review/ → new/ for the reproducible required-test failure. Next build should correct the test expectation, not alter correct production path display. No linked GitHub issues or PRs. Recovered the previous review worktree. No newly observed directly owned /tmp entries; harness /tmp/claude-995 remains inventoried, not deleted. Coder reported editing its existing memory note outside the permitted folders despite being told not to; unrelated user files were left untouched.

## factory · plan · 2026-11-25 17:45
Round 3 addition. Behaviour: use ownertools.DisplayPath(ws, workspace.HostHomeDir()) for the expected Solo workspace label, matching production's correct home abbreviation. Scope: the latest review's test portability P1 only; no production or UI changes. Decisions: preserve display semantics rather than forcing absolute labels. Checking: reproduce the old failure with TMPDIR inside isolated HOME; run the corrected focused test three times both inside and outside HOME, then all required Go and Console gates.

## factory · 2026-11-25 17:45
Round 3 built and pushed at b1e337a5. Moved new/ → review/.

Changed only cmd/mistermorph/consolecmd/solo_test.go: the expected workspace label now uses the production display contract. No runtime behavior, UI, config, documentation or dependency changes.

Checks: Claude Code reproduced the original failure, then passed the focused test three times with TMPDIR inside HOME and three times outside HOME. Required gofmt/vet/full Go gate passed on retry: one initial internal/agentpair TestManagerRecordsExpirationWithoutAnotherMessage failure observed reversed event order; it passed 10 isolated repeats and the next full suite. Manager independently reran gofmt, go vet ./..., go test ./..., the focused test three times with nested TMPDIR, and nsh check successfully. Required Console scripts/test.sh passed: 171 files, 0 failed, 272s; chat-attachments passed on the script's isolated retry. Manager verified the focused commit, item-only history plus master merge, and no protected paths in the feature diff.

No installs, manifest or lockfile changes. Scripted tests used isolated absolute HOME/XDG/cache paths with TMPDIR nested inside HOME and an offline read-only shared module proxy. No newly observed directly owned /tmp entries; coder reported no outside writes or Claude memory edits. No UI visual, native packaging or live-model checks this round (test-only change). Earlier review residual risks remain for review; no linked GitHub issues or PRs.

## factory · review · 2026-11-25 17:54
head: b1e337a562768ccc8881e6c38e1f9eacba54789f
verdict: pass

No qualifying findings. Claude Code reviewed the full 46-file feature diff in origin/master...HEAD (base 49e236f6), including round 3's test-only DisplayPath expectation, ownership/audience isolation, delegated workspace approval, persistence, concurrency, provenance and pagination. The previous portability blocker is cleared; earlier Login and P3 fixes remain clear. Branch merges cleanly with base; review worktree and HEAD unchanged.

Validation: required gofmt, go vet ./... and go test ./... passed with TMPDIR nested inside isolated HOME: 171 packages passed, 19 without tests, no Go retries. TestSoloSourceCollector passed three separate runs with TMPDIR inside HOME and three outside. nsh check passed (existing nsh 0.6.0). Required Console scripts/test.sh passed: 171 files, 0 failed, 271 seconds; chat-attachments initially failed with `role:button[Retry upload] is covered` and passed its isolated retry (12/12). All scripted tests used absolute throwaway HOME/XDG/tool caches with a read-only shared module proxy. No installs.

Residual risks, not established as introduced blocking defects: restart completion catch-up scans the newest 200 Solo records; editing earlier messages removes later cards; thread excerpts lack an explicit untrusted wrapper; terminal Solo has no work_thread/chips; cached topic pages can temporarily omit Solo; background card-sync goroutines are not awaited on shutdown. Visual UI, native builds, Android JVM tests and live-model end-to-end were not checked.

Round 3 of max 3: review/ → ready/. Owner should inspect the Solo flow and residual risks before shipping. No linked GitHub issues or PRs. Recovered the previous review worktree. No newly observed directly owned /tmp entries; harness /tmp/claude-995 stays inventoried, not deleted. No memory/settings writes reported. Review temporary files removed at end; no production commits or pushes in this review.

## factory · 2026-11-25 19:05
Merged into master by hand at the owner's word ("commit to master and push"), not by a ship run: merge commit 933f0506 (--no-ff) of branch head 74723bcd, pushed with the branch. Not tagged; the next v* tag releases it. Moved ready/ → done/ at the owner's word ("move to done.").

Beyond the reviewed head b1e337a5, the merge carries five commits that fix this review's residual risks:
- 400aedbf: a thread's reply is quoted as data, with markers it cannot close, in Solo's prompt and in its summary in Solo's history; the restart catch-up and the prompt read all Solo records page by page, not the newest 200. Shared Solo code moved to internal/solo.
- d30574a6: an edit in Solo keeps the work thread cards and summaries after the edited message (store, journal replay and Console); other topics unchanged.
- 0a473e85: the topic list saved for the next visit always keeps Solo.
- a22b5a33: Solo in a terminal chat without a Console runtime gets the Solo prompt and recent threads, points longer work to the Console (it cannot start work threads), /solo says so, and its replies keep their chips.
- 74723bcd: docs/console.md.

Checks on 74723bcd (the merge's tree is identical): gofmt, go vet ./..., go test ./... pass; nsh check passes; Console scripts/test.sh 171 files, 0 failed. New tests cover each fix.

Still open: background card-sync goroutines are not awaited on shutdown (the restart catch-up covers a missed update); no live-model end-to-end, visual or native check yet.
