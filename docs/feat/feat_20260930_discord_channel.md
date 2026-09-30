---
date: 2026-09-30
title: Discord Channel
status: draft
---

# Discord Channel

## 1. Goal

Morph gets a `discord` channel, on par with Telegram and Slack: a Discord bot that people talk to in direct messages
and in server channels and threads, with the same task runtime, commands, approvals, contacts, plan progress and
step messages as the other channels.

Some groundwork is already in the code and is kept: `channels.Discord`, `bus.ChannelDiscord` with the `discord`
conversation-key prefix, `discord` in the contacts channel checks and the inbound adapter switch, and the Discord logo
in the console. There is no runtime, client, config or command yet.

## 2. Discord platform facts

These decide the design. All calls use API v10 (`https://discord.com/api/v10`).

### 2.1 Bot identity and credentials

- A Discord **application** has a **bot user**. Its token authenticates both the Gateway and REST
  (`Authorization: Bot <token>`).
- The bot joins a **server** (guild) through an OAuth2 invite with the `bot` scope and a permission set. Morph needs:
  View Channels, Send Messages, Send Messages in Threads, Read Message History, Add Reactions, Attach Files.
- `GET /users/@me` returns the bot's user ID, name and avatar.
- IDs are snowflakes: 64-bit integers carried as strings.

### 2.2 Receiving: the Gateway

- A WebSocket from `GET /gateway/bot`. The server sends **Hello** (op 10) with a heartbeat interval; the client sends
  **Identify** (op 2) with the token and **intents**, then heartbeats (op 1) on that interval.
- **READY** gives `session_id`, `resume_gateway_url` and the bot user. Events arrive as **Dispatch** (op 0) with a
  sequence number.
- After a drop the client **Resumes** (op 6, `session_id` + last sequence) on `resume_gateway_url`, and Discord
  replays the missed events. **Reconnect** (op 7) asks for that. **Invalid Session** (op 9) says whether the session
  can be resumed; if not, the client identifies again, and events in the gap are lost.
- Close codes 4004 (authentication failed), 4013 (invalid intents) and 4014 (disallowed intents) are fatal: retrying
  cannot help.
- Events used: `MESSAGE_CREATE`, `INTERACTION_CREATE` (buttons), `GUILD_CREATE` (guild names for chat profiles).
- Intents: `GUILDS`, `GUILD_MESSAGES`, `DIRECT_MESSAGES`, and `MESSAGE_CONTENT`.
- **`MESSAGE_CONTENT` is privileged.** It must be switched on in the Developer Portal (without review for bots in
  fewer than 100 servers). Without it, a guild message arrives with empty content, attachments and embeds, except
  messages that mention the bot. Direct messages always carry content.

### 2.3 Sending: REST

- `POST /channels/{id}/messages`: content up to **2000 characters**; `message_reference` makes it a reply;
  `allowed_mentions` controls who gets pinged; `components` adds buttons; files go as multipart attachments.
- `PATCH /channels/{id}/messages/{message_id}` edits a message the bot sent.
- `POST /channels/{id}/typing` shows "typing…" for about 10 seconds, or until the bot sends a message.
- `PUT /channels/{id}/messages/{message_id}/reactions/{emoji}/@me` adds a reaction.
- `POST /users/@me/channels` with a `recipient_id` opens (or finds) the DM channel with a user.
- Attachment uploads have a size limit (10 MiB for bots without boosts at the time of writing; checked before upload).
- **Rate limits** are per route bucket, plus a global limit (50 requests per second). A 429 carries `retry_after`.
  The client must honour the `X-RateLimit-*` headers per bucket, not only retry after the fact.

### 2.4 Conversations

- A **DM** is a channel of type DM, with its own channel ID.
- A **guild channel** belongs to a server (`guild_id`).
- A **thread** is its own channel with a `parent_id`; messages in it carry the thread's channel ID.
- Mentions are written `<@USER_ID>` (older clients: `<@!USER_ID>`). A message's `mentions` lists the users mentioned;
  a reply's `referenced_message` holds the message replied to.

### 2.5 Interactions

- A button click arrives as `INTERACTION_CREATE` with the button's `custom_id` and the user who clicked.
- It must be answered within **3 seconds** (`POST /interactions/{id}/{token}/callback`), for example with
  `UPDATE_MESSAGE` (type 7) to replace the message. The interaction token then works for 15 minutes.
- Native slash commands (application commands) must be registered through REST before they appear. Plain text that
  starts with `/` is sent as an ordinary message when no such command is registered.

## 3. Alignment with Telegram and Slack

| Capability | Discord v1 | Notes |
| --- | --- | --- |
| Direct messages | Yes | Every allowed DM goes to the main run |
| Server channels and threads | Yes | Conversation per channel or thread |
| Allowlists | Yes | `allowed_guild_ids`, `allowed_channel_ids`, `allowed_user_ids` (section 4) |
| @mention and reply to the bot | Yes | By user ID, from `mentions` and `referenced_message` |
| Group trigger modes | Yes | `strict` works without `MESSAGE_CONTENT`; `smart` and `talkative` need it (section 7) |
| One run per conversation at a time | Yes | Key: `discord:<channel_id>` |
| History, sticky skills, context checkpoints | Yes | Shared channel task runtime |
| Shared slash commands | Yes, as text | In servers they need a bot mention; native slash commands are phase 5 |
| `/stop` and steering | Yes | Existing task control |
| Approvals | Yes | Buttons, plus `/approve` and `/deny` text commands |
| Image input | Yes | Downloaded to `file_cache_dir/discord/` |
| File output | Yes | `discord_send_file` tool |
| Reactions | Yes | `message_react` |
| Typing indicator | Yes | Refreshed every 8 seconds while a task runs |
| Plan progress | Yes | One progress message, edited in place, as Telegram's quote |
| Plan step messages | Yes | Each finished step's note as a message of its own, as Telegram |
| Streaming the final answer | No | Sent when complete (edit-based streaming could follow later) |
| `contacts_send` / `agent_send` | Yes | To a user (through their DM channel) or a channel |
| Agent pairing | Yes | Existing `internal/agentpair` |
| Cron notify target | Yes | `discord:<channel_id>` |
| Chat profiles | Yes | Guild and channel names, cached |
| Managed runtime in the console | Yes | `console.managed_runtimes: [discord]` |
| Runtime API | Yes | Existing `/runtime`, no Discord-specific API |
| Voice, stages, forums as boards | No | Section 15 |

## 4. Configuration

```yaml
# Discord bot mode (`morph discord`, Gateway).
discord:
  # REST base URL (override for mock/testing only).
  base_url: "https://discord.com/api/v10"
  # Bot token. Prefer env var: MISTER_MORPH_DISCORD_BOT_TOKEN
  bot_token: ""
  # Optional allowlist of server (guild) IDs. Empty allows every server the bot is in.
  allowed_guild_ids: []
  # Optional allowlist of channel IDs (a thread is allowed when its parent is). Empty allows all channels in allowed
  # servers. Also used as heartbeat notification targets in `morph discord`.
  allowed_channel_ids: []
  # Optional allowlist of user IDs for direct messages. Empty allows DMs from anyone who can reach the bot.
  allowed_user_ids: []
  # Group trigger mode:
  # - strict: only @mentions of the bot and replies to it trigger in servers.
  # - smart: every server message goes through addressing LLM classification; `addressed=true` is required.
  # - talkative: every server message goes through addressing LLM classification; does not require `addressed=true`.
  # smart and talkative need the privileged Message Content intent (Developer Portal -> Bot).
  group_trigger_mode: "strict"
  # Persist valid server messages rejected by group trigger to the shared journal.
  record_untriggered: false
  # Minimum confidence required to accept the LLM addressing classification.
  addressing_confidence_threshold: 0.6
  # Minimum interject required to accept the LLM addressing classification.
  addressing_interject_threshold: 0.6
  # Per-message agent timeout (0 uses top-level timeout).
  task_timeout: "0s"
  # Max number of conversations processed concurrently.
  max_concurrency: 3
  # Runtime API listen address for the Discord runtime (standard base path: `/runtime`).
  # Protected by server.auth_token.
  serve_listen: ""
```

- `group_trigger_mode` defaults to `strict`, the one mode that works without a privileged intent. Starting with
  `smart` or `talkative` requests `MESSAGE_CONTENT`; if Discord refuses it (close code 4014), the runtime stops with
  an error that says how to enable it or to use `strict`.
- The token is a secret like the other channels' tokens: env var first, and never returned by the console API.
- `assets/config/config.example.yaml`, the config defaults, the console settings fields and the docs site get the same
  keys.

## 5. Identity and routing

### 5.1 Canonical IDs

| Object | Morph reference |
| --- | --- |
| Discord user or bot | `discord_user:<user_id>` |
| Discord channel, thread or DM channel | `discord:<channel_id>` |
| Bus channel, chat history channel | `discord` |
| Conversation key | `discord:<channel_id>` |

This follows LINE and Lark (`line_user:`, `lark_user:`): the `_user` form names a person, the plain form a chat.
`contact_id` is always a user; `chat_id` and the conversation key are always a channel.

### 5.2 Contacts

`contacts.Contact` gains:

```text
DiscordUserID
DiscordDMChannelID
DiscordChannelIDs
```

On each message:

- `ContactID = discord_user:<user_id>`.
- `ContactNickname` is the server nickname, then the global display name, then the username.
- A sender with `bot: true` is `KindAgent`.
- The channel is added to `DiscordChannelIDs`; a DM channel is stored as `DiscordDMChannelID`.
- Sending to a user with no stored DM channel opens one (`POST /users/@me/channels`) and stores it.

`contacts/service.go` and `file_store.go` accept `discord` and `discord_user` references, like `line`/`line_user`.

### 5.3 Pairing and allowlists

Discord agents pair with `discord_user:<user_id>` through `internal/agentpair`, with the same rules as Telegram and
Slack:

- An admin's pairing command is handled before the allowlists.
- A paired agent's DM passes `allowed_user_ids`.
- An unpaired bot's DM from outside the allowlist is dropped silently, so two bots never answer each other in a loop.
- Messages from the bot itself are always ignored, and so are other bots' messages in servers: they cannot be told
  apart from a loop.
- Discord does not let one bot DM another, so pairing two Morph bots that are both on Discord cannot complete; the
  commands are kept for parity with the other channels.

Global `admins` accepts `discord_user:<user_id>`.

## 6. Receiving

```text
Gateway WebSocket
  -> Hello, Identify (or Resume), heartbeat loop
  -> Dispatch MESSAGE_CREATE / INTERACTION_CREATE / GUILD_CREATE
  -> ignore the bot's own messages and system message types
  -> allowlists / pairing control
  -> normalize to BusMessage
  -> check persistent inbox dedupe by (discord, message_id)
  -> publish to the in-process bus, then record the seen message
  -> per-conversation worker
       -> DM: command or main run
       -> server: command (with a bot mention) or group trigger
            -> accepted: main run
            -> rejected: optional untriggered journal
  -> outbound bus
  -> REST
```

### 6.1 Delivery and dedupe

Discord has no per-message acknowledgement: the heartbeat's sequence number is the only receipt, and Resume replays
from it. Dedupe uses the shared bus inbox `(discord, message_id)` so a replayed event never starts a second task. A
session that cannot be resumed loses the events in the gap; v1 does not backfill them from channel history (section
16).

### 6.2 Gateway lifecycle

- Heartbeat on the server's interval, the first after a random fraction of it. A heartbeat not acknowledged by the
  next one means the connection is dead: close it and resume.
- Reconnect with exponential backoff with jitter, 1 second to 30 seconds, not configurable. Resume when possible.
- Close codes 4004, 4013 and 4014, and a 401 from REST, stop the runtime with a clear error; no retry loop.
- The read loop only decodes and queues; it never runs the LLM. Order is kept within a conversation.
- Cancelling the context closes the socket, stops reconnecting and waits for workers.
- `GET /users/@me` runs once at start. Guild and channel names come from `GUILD_CREATE` and are cached in memory.
  Endpoint listings, task lists and health checks never call Discord synchronously.

## 7. Server messages

- **strict** (default): a message triggers when it mentions the bot (`mentions` contains the bot's user ID) or replies
  to one of the bot's messages. These messages always carry content, even without `MESSAGE_CONTENT`.
- **smart** and **talkative**: every message in an allowed channel goes through `internal/grouptrigger`, as on
  Telegram and Slack. They require `MESSAGE_CONTENT`.
- Before the main run, only mentions of this bot are removed from the text; other mentions stay.
- Threads are separate conversations. A reply in a thread stays in that thread.

### 7.1 Commands

In DMs, the shared commands work as plain text: `/help`, `/models`, `/skills`, `/ctx`, `/workspace`, `/think`,
`/reset`, `/stop`, `/id`, `/approve`, `/deny`.

In servers, a command must mention the bot, so several bots in one channel do not all answer:

```text
@Morph /models
```

Native slash commands (registered, with autocomplete) are phase 5.

## 8. Messages and files

### 8.1 Text

- Final answers are Markdown, which Discord renders natively (bold, italics, code, lists, headings, links).
- Text longer than 2000 characters is split on paragraph, then line, boundaries, never inside a code block; an open
  fence is closed at the end of a part and reopened in the next.
- Every message sets `allowed_mentions: {"parse": []}`, so an answer that quotes `@everyone`, a role or a user never
  pings anyone. The reply to the triggering message sets `replied_user: false`.
- In servers, the answer replies to the triggering message (`message_reference`, `fail_if_not_exists: false`), so it
  is clear what it answers when the channel is busy. DMs send plain messages.

### 8.2 Incoming attachments

Image attachments (by `content_type`) are downloaded from their CDN URL to `file_cache_dir/discord/` and go through the
existing image input. Other files are not downloaded in v1: the message text given to the agent names each one with its
size, so the agent knows they were sent.

### 8.3 Outgoing files

`discord_send_file` (in `tools/discord/`) uploads a file from the workspace to the current conversation, after the size
check. `message_react` adds a reaction to the triggering message.

## 9. Progress

While a task runs:

- **Typing:** `POST /typing` at the start and every 8 seconds until the task ends.
- **Plan progress:** one message, sent when the plan is created and edited in place as steps start, like Telegram's
  plan quote.
- **Step messages:** each finished step's note is sent as a message of its own, before the final answer, and recorded
  in chat history, as on Telegram (see [plan step feedback](./feat_20260930_plan_step_feedback.md)).
- **Final answer:** sent when complete.

## 10. Approvals

An approval is one message: what is being approved, why, the tool parameters, and two buttons (`Approve`, `Deny`)
whose `custom_id` is `morph:approve:<approval_id>` or `morph:deny:<approval_id>`. The text also shows the fallback
commands (`/approve <id>`, `/deny <id>`; in servers with a bot mention).

On a click:

- A click counts from any user who may use the bot in that conversation (the allowlists of section 4), as on Slack,
  and is recorded as theirs.
- The approval must be pending and not expired. A repeated click answers with the approval's final state and resumes
  nothing.
- The interaction is acknowledged at once (`DEFERRED_UPDATE_MESSAGE`), well inside Discord's 3 seconds, and the
  approval is decided after that; the bot then edits the approval message, replacing the buttons with the outcome
  (approved or denied, by whom). The task resumes after that. A click from someone the allowlists refuse gets an
  ephemeral "not allowed" reply and changes nothing. A decision made by command, or an expiry, edits the message the
  same way.

Buttons and commands use the same approval state and audit path in `internal/channelruntime/core`.

## 11. Code boundaries

New code:

```text
cmd/mistermorph/discordcmd/
internal/channelruntime/discord/
internal/bus/adapters/discord/
internal/discordapi/
tools/discord/
```

`internal/discordapi` implements only what this document uses:

- Gateway: connect, Hello, Identify, Resume, heartbeat, dispatch decoding, close codes.
- REST: `users/@me`, create, edit and reply to messages (with components and files), typing, reactions, DM channel,
  interaction callback, attachment download.
- Rate limits: per-bucket and global, from the response headers, with 429 handling.

It is not a general Discord SDK, like `internal/slackclient` and `internal/mixinapi`. Morph already depends on
`gorilla/websocket`, which the Gateway needs; a full SDK (for example `discordgo`) would bring voice, sharding and
state caches this channel does not use.

Shared pieces stay shared: `internal/channelruntime/core` (bootstrap, runner, approvals, untriggered journal),
`internal/grouptrigger`, `internal/bus`, `contacts`, `internal/chathistory`, `internal/contextcheckpoint`,
`internal/channelruntime/taskruntime`. Only what the platform protocol forces is Discord-specific.

A prompt block (`internal/promptprofile/prompts/block_discord.md`) tells the agent the formatting rules (Markdown,
2000-character messages split automatically, no mass mentions) and the Discord tools.

## 12. CLI, console and integration

### 12.1 CLI

```bash
mistermorph discord
```

Log mode, request dump name and task persistence target are `discord`. At start:

1. Check the token is set.
2. Call `GET /users/@me` once to validate it and cache the bot profile.
3. Initialise bus, contacts, journal, task runtime and runtime API.
4. Connect the Gateway.

### 12.2 Console managed runtime

`console.managed_runtimes` accepts `discord`. Settings -> Channels gains a Discord block: bot token (write-only),
allowed server, channel and user IDs, and trigger mode. Changes restart the managed runtime, as for the other
channels. The endpoint list shows the cached bot name and avatar; Gateway state shows in runtime health.

### 12.3 Integration API

`Runtime.NewDiscordBot(DiscordOptions)`, like the other channels' constructors.

## 13. Errors and observability

- Structured logs for connect, identify, resume, reconnect (with the close code), invalid session and fatal close.
- Rate limits: log each 429 with its bucket and `retry_after`; a global 429 pauses all requests.
- Sending failures (missing permission, unknown channel) are logged with the Discord error code and reported to the
  task, not retried forever. A missing permission names the permission in the log.
- Runtime health: Gateway connected or not, last event time, resume count.

## 14. Phases and tests

### Phase 1: protocol client

`internal/discordapi` with a fake Gateway (`httptest` + WebSocket) and a fake REST server: identify and heartbeat,
resume and replay, reconnect and invalid session, fatal close codes, rate-limit buckets and 429, message create and
edit, multipart upload, interaction callback.

### Phase 2: channel basics

Runtime, bus adapter, allowlists, DMs, strict trigger, commands, message splitting, `allowed_mentions`, replies,
typing, dedupe on replay.

### Phase 3: groups, approvals, contacts

smart and talkative triggers, threads, approval buttons and commands, contacts and pairing, image input,
`discord_send_file`, `message_react`, plan progress and step messages.

### Phase 4: entry points and docs

`morph discord`, the console managed runtime and settings, the integration constructor, config example, docs site
pages (en, zh, ja).

### Phase 5 (later): native slash commands

Register the shared commands as application commands and answer them through interactions.

## 15. Acceptance

- A DM to the bot gets an answer; a server message gets one only when it mentions or replies to the bot (strict).
- A 5,000-character answer arrives as three messages, code blocks intact, and pings nobody.
- A dropped connection resumes without a duplicate task; a revoked token stops the runtime with a clear error.
- An approval button works once, only for an allowed user, and the message shows who decided.
- A planned task shows one edited progress message, step messages, then the final answer.
- The console can enable Discord as a managed runtime and never returns the token.

## 16. Non-goals and decisions

Not in this change: voice and stage channels, forum channels as boards (a forum post works as a thread), embeds
beyond what messages need, sharding (one connection serves up to 2,500 servers), backfilling messages lost to a
non-resumable session.

Decisions (2026-09-30):

1. **DMs with an empty `allowed_user_ids`** allow everyone who can reach the bot, as Telegram's empty allowlist does.
   Operators who want less set the allowlist.
2. **Own client.** v1 uses the small `internal/discordapi` client (section 11), not `discordgo`.
3. **No streaming in v1.** The final answer is sent when complete. Edit-based streaming can come later, within
   Discord's edit rate limit (about 5 edits per 5 seconds per channel).
4. **Approvals in a server channel** work as on Slack: anyone who may use the bot in that conversation can approve or
   deny, and the click is recorded as theirs.

## 17. Progress

- **Phase 1 (done):** `internal/discordapi`. REST: bot user, Gateway URL, channel lookup, create (with replies,
  buttons, files) and edit messages, typing, reactions, DM channels, interaction callbacks without the bot token, and
  attachment downloads only from Discord's CDN, never with the token. Rate limits per route from the response headers,
  a global pause on a global 429, 429 and 5xx retries; other errors decoded with their Discord code. Gateway:
  identify, heartbeats with ack tracking, resume on the resume URL after drops or a Reconnect, identify again after a
  non-resumable invalid session, fatal close codes stop with a clear error. Tested against a fake REST server and a
  fake Gateway, under the race detector.
- **Phase 2 (done):** `internal/channelruntime/discord`. The Gateway read loop only decodes; messages go through a
  per-channel queue (order kept, the loop never waits on a download or a trigger decision). Allowlists for servers,
  channels (a thread through its parent) and DMs; other bots' DMs need a listing or pairing. Strict trigger (a mention
  or a reply to the bot, which ingress records as the bot's ID among the mentions); commands in servers need it too.
  Replies in servers refer to the triggering message; text is split to 2,000 characters; nothing pings. Typing is
  renewed every 8 seconds. Dedupe through the shared bus inbox. `morph discord` asks for Message Content only when
  the trigger mode needs it, and a refused intent stops the runtime with a message that says what to do.
- **Phase 3 (done):** smart and talkative through `internal/grouptrigger` (with the reaction path and the untriggered
  journal); approvals with buttons and commands; contacts, `discord_user:` admins and pairing; image input (other
  attachments named with their size); `tools/discord` (`message_react`, `discord_send_file`); one plan message edited
  in place and each step note as its own message, recorded in history before the answer.
- **Phase 4 (done):** `morph discord` (with heartbeat and cron beside it; heartbeats go to `allowed_channel_ids`),
  config defaults and example, channel options, settings fields, the console managed runtime and its settings card
  (token write-only), Runtime and Overview channel cards, contacts handles, `integration.NewDiscordBot`, and docs
  (`docs/discord.md`, the READMEs, the docs site in en, zh and ja).
- **Phase 5 (done):** the shared commands are registered as global slash commands on the first READY. A slash command
  runs as the text command it names: it is acknowledged with Discord's "thinking…" placeholder, the first reply
  replaces the placeholder (later ones refer to it), and a run that sends nothing removes it. Allowlists apply as for
  typed commands, with a refusal as an ephemeral reply.
