# Heartbeat Checklist


*THIS IS NOT A TODO FILE, DO NOT ADD TASKS HERE*

*THE PURPOSE OF THIS FILE IS TO LIST WORKFLOWS TO BE CHECKED DURING REGULAR HEARTBEAT*

<!-- 
==Example Begin==

## Contacts Proactive Check

- Use `memory_recently` first (`days=3`, `limit=20`) to load recent context and routing clues.
- Use `read_file` to read `file_state_dir/contacts/ACTIVE.md`, then select contacts for the current round.
- Send selected items using `contacts_send` (one send call per selected contact).
- Session feedback states are updated by runtime program flow (no LLM tool call needed).
- If no contact is selected, summarize the reason (for example: no fresh candidates, cooldown, trust constraints).
- If sending fails, summarize the error and move to next action.

==Example End==

Above are just examples, do not consider them as actual tasks to be done.
-->


## Check TODO.md

- Check the `TODO.md` file for any pending tasks using `read_file` tool.
- If there are tasks and if there are contacts that match the task context, consider reaching out to them using `contacts_send` tool.
- Parse optional task context prefix: `ChatID: tg:<chat-id>`.
- For each mentioned person in a TODO item:
  - Resolve the person to a contact profile first.
  - Call `contacts_send` with `contact_id`.
  - If the TODO item has `ChatID:`, also pass it as `contacts_send.chat_id`.
  - If contact resolution or send fails, skip this person and include the reason in the heartbeat summary.
