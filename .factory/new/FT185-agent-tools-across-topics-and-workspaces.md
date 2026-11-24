# Agent tools to reach across topics and workspaces (step 1 of SOLO mode)

## factory · 2026-11-24 23:30
Owner request (design agreed in conversation): a SOLO mode, where the user talks in one conversation and the agent itself reaches whatever the task needs: other workspaces, other topics, channels, memory. SOLO sits beside topics as a mode, it does not replace them. This item is step 1: the tools the agent needs, useful in ordinary topics too. Step 2 (FT186, in backlog until this ships) builds the Solo conversation and its Console UI on them.

Today a chat task runs in the workspace attached to its topic (`internal/workspace/attachment.go` `Store`, resolved by `workspaceForTopic` in `cmd/mistermorph/consolecmd/local_runtime.go:1033`), and the agent cannot list the workspaces it knows or open another topic. It can search the journal (`journal_search`, `journal_read`) and memory (`memory_search`), registered in `internal/memorytools/memorytools.go` and found with `tool_search` when that is on (docs/memories.md "Tools").

1. **`workspace_list`**: the workspaces the agent knows: those attached to topics (with each one's topic titles), the default workspace, and the most recently used, newest first; each with its path, whether it still exists, and when it was last used. Read-only.
2. **Use a workspace for this task**: a tool (`workspace_use`, or a parameter; pick one) that switches the running task to another known workspace, or a path the user named, for the rest of the run: `read_file`, `write_file`, `bash`/`powershell` working directory, `send_file` path roots and file references all follow it. The topic's own attachment does not change. The switch shows in the run's activity ("Using ~/proj/api"). The first write or shell command in a workspace other than the topic's own asks for approval through the existing approval flow, once per task; reading does not. Protected paths and `deny_paths` still apply.
3. **`topic_search`**: find topics by title, tags and what was said in them (the topic's tasks: user messages and replies; reuse the journal or the console store, `internal/daemonruntime/console_store.go` `ListTopicsPage`): ID, title, last activity, workspace, a short match excerpt. Bounded results.
4. **`topic_read`**: one topic's conversation, newest first, paginated with a cursor, each task's message and reply (cut to a bounded size), its workspace and its files' names; never another audience's private conversation.
5. **Who gets them**: the Console owner's chat runs (the owner may see every topic). Channel runtimes, cron runs and subagents do not get `topic_search`/`topic_read`; `workspace_list` and the switch follow the same rule unless a reason appears. Registered like the memory tools (through `tool_search` when on), with descriptions that tell the model when to use them.
6. Document them in docs (tools page and docs/console.md), and add them to Settings' tool toggles if built-in tools are listed there.

Acceptance criteria:
- Go tests: `workspace_list` lists attached, default and recent workspaces; a switch moves file tools and the shell's working directory, leaves the topic's attachment, and asks once before the first write elsewhere; `topic_search` and `topic_read` find and page a topic and refuse outside the owner's Console runs.
- `go test ./...`, `go vet ./...` and the full Console test runner pass.
