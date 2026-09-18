# Terminal chat

Run `morph chat` (or `morph`) to create and continue topics shared with Web Console.
The agent runs in the chat process. Chat does not start Console, open a Web
listener, or require `server.auth_token`. Start `morph console` separately when
you want the Web UI. Both commands must use the same `file_state_dir` and task
storage configuration, with `console` in `tasks.persistence_targets` (the default).

Chat opens a new conversation directly. The first message creates the shared
topic; Web Console then shows the same topic and history. Use `/topics` to open
the topic picker, `/topic new` to start another conversation, or
`morph chat --topic <id>` to continue an existing one directly.
Exiting chat cancels its active local task and saves the outcome. It does not
stop a separately running Console.

Sending the first message continues the chat without inserting a topic heading.
The Running spinner and elapsed time appear while sending or executing a task.
They disappear when the task finishes
and are not added to the conversation transcript. The status below the input
shows the model, workspace, and known context usage while running and after
completion. Narrow windows keep this status ahead of keyboard hints.

Chat uses one terminal UI for both Console and local execution: the same input
box, keyboard controls, completion menus, paste handling, and input history.
Type `/` to browse commands or `$` to browse skills. With a Console connection,
skill candidates come from that runtime. Use Up/Down to select, Tab to complete,
and Esc to close the menu. Enter runs a selected command; for a skill, it inserts
the reference without sending. Use Ctrl+J or Shift+Enter for a newline, Enter to
send, and `/status` for connection and workspace details.

While a local task runs, Esc, Ctrl+C, or `/stop` stops it. Finish or stop the
current turn before switching topics, resetting context, or changing workspace.
Pending approvals use the same approval panel: press y/n or use `/approve`
and `/deny`. Resolve a local task's approval in the terminal that owns it.
Web and chat can read shared history while a task runs; another executor must
wait for that topic to become idle before starting a turn.

`/reset` clears the topic's model context but keeps its shared chat history.
`/init` creates AGENTS.md in the topic's workspace, or displays the existing file;
`/update` regenerates it. These commands use the local workspace.
Submitted input history is saved locally, including multiline input, for recall
with the arrow keys. It is separate from shared conversation history.

Use `--runtime-url <full-base-url>` to connect to another Console. This override
requires that Console to expose its runtime API with `server.auth_token` and
requires `MISTERMORPH_RUNTIME_TOKEN` on the client. See [shared topics](console.md#shared-topics-in-the-terminal)
for workspace, history, and connection details.

Local flags such as `--model` and `--workspace` work with ordinary `morph chat`.
`--standalone` remains a hidden compatibility alias for this same behavior.
Only an explicit `--runtime-url` delegates execution to Console. In that case,
paths and skills belong to the remote runtime; exiting the client leaves its
tasks running, and local execution overrides are rejected.

## Inspect subagents

Use `/agents` to open the agent picker. `/agent` and `/subagents` are aliases.
Press Up or Down to select a child, then Enter to view its execution record.
Use `/agents <id>` to open a child directly; full IDs and unique ID prefixes
are accepted.

The view shows the task, model, current step, elapsed time, inherited deadline,
model requests, tool calls and their returned output, retries, and final result
or error. It updates while the child runs. A child past its deadline that has
not returned is marked **Timed out · waiting for exit**.

- Up/Down and Page Up/Page Down scroll the record.
- Home goes to the first retained entry; End follows new entries.
- Esc returns to the picker, then to the main conversation.
- Ctrl+G opens the picker from chat, including during an approval, and returns
  to chat from either inspection view. The input draft is preserved.
- Ctrl+C in the inspection view returns to chat. To stop the task, return to
  chat and use `/stop`.

Inspection is read-only and does not send instructions to either agent. The
parent task continues while the view is open. Main-thread output received
during inspection appears when you return to chat.

The inspector is available with both Console and local execution. Both store a
bounded trace with each completed or pending task. Remote Console also streams
execution records. Reopening a topic restores its retained tool output, plans, file
changes, and child records. Older tasks restore their saved plans and tool
activities; details that were never stored cannot be recovered. Console must run the updated version
to provide these records and the restored commands.

The inspector keeps up to 32 records, retaining running children even when that
limit is reached. Each record keeps at most 128 entries and 256 KiB of entry text;
individual text fields are limited to 16 KiB. Shared history retains up to 512 trace
entries and 256 KiB per task; file diffs require each file version to fit within
64 KiB. Truncated output and omitted entries are marked. Persisted local records
are restored when reopening the topic.
