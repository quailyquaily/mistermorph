# Memories

The agent keeps memories: facts it saves on purpose because they change later answers. A correction ("send release notes to me by DM, not to #eng"), who someone is, what they are working toward, a deadline, where something lives.

Memories are not a log of conversations. The [journal](./configuration.md#task-journal-and-projections) is that record, and the agent can search it. A memory is what the journal cannot give back quickly: the one fact, with why it matters and how to apply it.

Design: [feat_20261027_memories.md](./feat/feat_20261027_memories.md).

## Who hears what

Every run has an **audience**, set by the runtime from where the message came from. The model never picks it.

| Where | Audience |
|---|---|
| Console, TUI, a direct message from a contact marked as the owner | the owner |
| A direct message from anyone else | that contact |
| A group, channel or thread | that conversation |
| Heartbeat tasks | the owner, reading only |
| Cron tasks, `mistermorph run`, subagents | none: no memories, no journal search |

A group is a public square. Even when the agent knows people in it, it hears only memories learned in that group and public ones. What someone told it in private stays out of the prompt, so it cannot be repeated there.

Each memory has a **visibility**:

- **private:** the owner, and the contact whose direct message it was learned in;
- **conversation:** the owner, the conversation it was learned in, and the direct messages of the contact it is about or who said it;
- **public:** everyone.

Memories saved in a direct message default to private, and in a group to conversation. A contact can make public only what is about them. A group cannot make anything public; the owner can widen any memory from the Console.

Who may set rules (memories of type feedback):

- The owner may set rules for anything, including how the agent works in general.
- A contact may set rules only for working with them.
- A group's rules can be set only by a message from the owner. A request from another member is followed in that conversation, not saved.

A memory one contact told about another keeps who said it (`told_by`), and the agent treats it as that person's claim.

## Marking the owner

The Console and the TUI are always the owner. To be recognized as the owner on a chat channel, mark your own contact there:

1. Console > Contacts > select yourself.
2. Turn on **This is me**. (It writes `owner: true` into the contact's YAML, which you can also edit by hand.)

Only the Console can set or clear this flag. Nothing a contact sends can, however it describes itself. Mark each channel's contact you use.

## Tools

| Tool | Visible | Does |
|---|---|---|
| `memory_save` | always | create or replace a memory (same subject and name replaces) |
| `memory_search` | found with `tool_search` | search the memories this audience may hear |
| `memory_forget` | found with `tool_search` | delete a memory learned here (the owner may delete any) |
| `journal_search` | found with `tool_search` | search what people said in this audience's conversations |
| `journal_read` | found with `tool_search` | read one journal event |

With `tools.tool_search.enabled: false` all five are ordinary tools. A memory or journal event the audience may not hear reads as not found.

The system prompt holds the rules for saving: save corrections, confirmed approaches, what people say about themselves, and what you are asked to remember; never summaries of what was done, things that matter only in the task, or secrets. The memories the run may use without searching come in a `[[ Saved Memories ]]` message of their own, right before the person's message, read fresh when each run starts. Up to 64 are shown: first those the conversation is about (matched against the current message and the turn before it, in English, Chinese or Japanese, and marked `relevant="true"`), then every feedback memory, then the newest. Bodies fit in 6 KiB in total, relevant ones first; past that, a memory shows only its description. A message in one language does not find a memory written in another yet. Keeping the memories out of the system prompt means a save does not cost the prompt cache of the conversation. The context window inspector (Chat > context meter) shows the note as its own row under Current message.

## The reminder

After 8 finished turns without a save in a direct conversation (20 in a group), the next run's message gets a short runtime note asking the agent whether anything in the recent turns is worth saving. It costs no model call. The log line `memory_reminder` shows when it fires; the thresholds are first guesses to tune from those logs.

## Console

Console > Memories shows everything, including what contacts told the agent in private: it is your agent and your data. Like Contacts, it lists what you can open in the second column: all memories, the journal, then each subject.

- **Subjects.** You, general, each contact and each group. Each subject's rules (feedback, which changes how the agent behaves) come before its facts. Each memory starts with who may hear it (Private, Conversation or Public), and a contact's word about someone else reads as their claim ("Alice says: …"). Open a memory to change who may hear it, edit it, forget it, or see its sources in the journal. Making a memory Public asks first.
- **Journal.** Search what was asked and answered. An event that led to a memory links to it, and an event from a Console chat links to that chat.

A contact's detail shows the memories about them. Deleting a contact deletes the memories about them; what they told the agent about others, and their journal events, stay.

## Storage

- `<file_state_dir>/memory.db`: memories and the reminder counts.
- `<file_state_dir>/journal/journal.db`: the journal.

Both are SQLite, readable only by their owner. Back them up with the rest of `file_state_dir`.

Contacts' former `persona_brief` and `topic_preferences` fields are moved into private memories about each contact on the first run that uses memories, and then removed from the contacts file.

## Turning it off

```yaml
memories:
  enabled: false
```

Runs then get no memory tools, no memories in the prompt, and no journal search. Saved memories stay in `memory.db`.
