# Terminal chat

Run `morph chat` (or `morph`) for a local interactive session.

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

Records belong to the current local TUI session and are not restored after a
restart. The session keeps up to 32 records, retaining running children even
when that limit is reached. Each record keeps at most 128 entries and 256 KiB
of entry text; individual text fields are limited to 16 KiB. Truncated output
and omitted entries are marked in the view.

These commands apply to standalone `morph chat`. The Console connection mode
(`--runtime-url`) does not provide this inspector.
