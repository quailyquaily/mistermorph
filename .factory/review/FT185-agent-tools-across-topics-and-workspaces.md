---
branch: factory/FT185-agent-tools-across-topics-and-workspaces
round: 1
---
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

## factory · plan · 2026-11-25 01:04

Behaviour:
- Owner Console chat runs discover workspace_list/workspace_use/topic_search/topic_read through the normal registry/search flow; channel, cron and subagent runs cannot invoke them.
- List deduplicated attached/default/recent workspaces with titles, existence and last use, most recent first; empty stores return bounded empty/default results without failure.
- workspace_use validates a known workspace or explicitly user-named path, switches only this run's effective workspace, and emits an activity event. All file/shell/send-file resolution follows it; durable topic attachments stay unchanged. Missing/invalid/denied paths fail without changing state.
- Reads need no extra approval. First write or shell use in a non-original workspace uses the existing approval mechanism and remembers approval for this task; denial must not execute. Protected paths and deny_paths remain enforced, including aliases/symlinks.
- Topic search matches titles/tags/user and assistant task text, returns bounded metadata/excerpts; topic read uses stable newest-first cursor pagination, bounded content and file names. Restrict data to the owner Console audience, including when reading journals.
Scope:
- Implement store queries, run-scoped workspace state, tool registration/catalog/descriptions, existing approval integration, tests and English tools/Console docs. Add Settings toggles where applicable.
- No SOLO mode, Solo conversation UI, channel access, cross-audience journal access, attachment mutation or unrelated cleanup.
Decisions:
- Use workspace_use as the explicit switch tool; default bounded limits and opaque stable cursors consistent with store conventions.
- Reuse existing Console/topic and workspace data stores and approval infrastructure rather than inventing a parallel service. Persist recent-use timestamps only if existing records do not provide them.
- Validate privilege at invocation as well as registration; do not grant workspace capabilities to child runs via inherited dependencies.
Checking:
- Regression tests cover dedup/default/recent/missing list entries, title/text/tag search, bounded paging and audience refusal, file/shell/send-file roots after switches, unchanged attachment, once-per-task mutation approval and denial, protected/denied paths.
- Required gofmt + go vet ./... + go test ./...; nsh check and full web/console-nsh/scripts/test.sh. Scripted tests use isolated absolute HOME and XDG/cache paths; preserve tool discovery through PATH.
- No browser UI is intended; note explicitly whether any UI changes were visually checked.

## factory · 2026-11-25 01:04

Implemented in commits 0cef31b6 and d403e5f9. Added owner-only workspace_list, workspace_use, topic_search and topic_read, discovery/catalog registration, run-scoped workspace roots, activity events, audience checks and regression tests. Topic attachments do not change. File tools, shells, send_file and file-write tracking follow the selected workspace; children get a fixed workspace copy, not the owner tools.

Decisions: explicit workspace_use; recent-use metadata in the shared database (latest 100); bounded topic search and cursor-based reads; first mutation approval once per destination workspace per task, including when general guard approvals are disabled, with resume/denial/batched-call coverage. Settings Tools matrix lists the four Console tools; no new configuration keys. Updated English tools and Console docs.

Installs: none beyond restoring pinned dependencies.

Checks: gofmt clean; go vet ./... and go test ./... pass, independently rerun by manager in isolated HOME. Coder reports nsh check (repository-pinned 0.6.0) passed; Console runner log confirms 164 files, 0 failed. git diff --check passes. No forbidden paths changed; both commits contain only this item's work.

Not checked: live model discovery/use and manual approval-card click-through. UI changed (Settings Tools matrix); not visually checked in a browser.

Process deviations: coder wrote personal CLI memory notes outside the worktree/TMPDIR; these were not committed. Its report also identifies harness output under /tmp/claude-995; retained in the run outside list, not deleted. No user-level installs.

Branch pushed; moved new/ → review/. Not merged into master.
