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
