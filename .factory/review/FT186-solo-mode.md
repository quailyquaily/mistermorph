---
branch: factory/FT186-solo-mode
round: 1
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
