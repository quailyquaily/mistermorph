# Discord

Mister Morph can run as a Discord bot in direct messages, server channels, and threads. It receives events over the Discord Gateway (a WebSocket) and sends replies through the Discord REST API. There is no webhook to host.

## Create the bot

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an Application, open **Bot**, and copy the bot token.
2. Keep the token out of the repository. Put it in `config.yaml` or set `MISTER_MORPH_DISCORD_BOT_TOKEN`.
3. Invite the bot to a server: under **OAuth2 → URL Generator**, pick the `bot` scope and at least these permissions: View Channels, Send Messages, Send Messages in Threads, Read Message History, Add Reactions, Attach Files.
4. Only for the `smart` and `talkative` trigger modes: under **Bot → Privileged Gateway Intents**, turn on **Message Content Intent**. The default `strict` mode does not need it.

## Configuration

```yaml
discord:
  bot_token: ""                 # or MISTER_MORPH_DISCORD_BOT_TOKEN
  allowed_guild_ids: []         # servers; empty allows every server the bot is in
  allowed_channel_ids: []       # channels; a thread is allowed when its parent is
  allowed_user_ids: []          # DMs; empty allows anyone
  group_trigger_mode: "strict"  # strict | smart | talkative
  record_untriggered: false
  addressing_confidence_threshold: 0.6
  addressing_interject_threshold: 0.6
  task_timeout: "0s"
  max_concurrency: 3
  serve_listen: ""
```

All IDs are Discord snowflakes (numbers). Turn on **Developer Mode** in Discord (Settings → Advanced) to copy them from the right-click menu, or send `/id` to the bot.

`allowed_user_ids` applies to direct messages. Another bot can DM this one only when it is listed there or paired, even when the list is empty, so two bots never answer each other in a loop. Messages from other bots in servers are ignored.

## Start the runtime

```bash
morph discord
```

The main CLI overrides are:

```text
--discord-bot-token
--discord-allowed-guild-id
--discord-allowed-channel-id
--discord-allowed-user-id
--discord-group-trigger-mode
--discord-addressing-confidence-threshold
--discord-addressing-interject-threshold
--discord-task-timeout
--discord-max-concurrency
```

To expose the standard remote Runtime API, set a server token; the default listen address is `127.0.0.1:8793`:

```yaml
server:
  auth_token: "${MISTER_MORPH_SERVER_AUTH_TOKEN}"

discord:
  serve_listen: "127.0.0.1:8793"
```

The API base path is `/runtime`.

When heartbeat or cron is enabled, `morph discord` runs them next to the bot. Heartbeat notifications go to `discord.allowed_channel_ids`; with no channel listed, they are not sent.

## Run it inside Console

```yaml
console:
  managed_runtimes: ["discord"]
```

The Discord runtime then shares the Console task store and does not appear as a separate endpoint. Its configuration is in Console Settings → Channels.

Do not run the same bot as a managed runtime and as a separate `morph discord` process at the same time: both would answer every message.

## Direct messages and servers

Every DM starts a task.

In servers, `group_trigger_mode` decides which messages do:

- `strict` (default): a message that mentions the bot, or replies to one of its messages.
- `smart`: every message goes through the addressing model; it must judge the message addressed to the bot.
- `talkative`: every message goes through the addressing model; the bot may also join in when it has something to add.

Each channel and each thread is its own conversation, keyed `discord:<channel_id>`. In servers the answer replies to the triggering message. Answers never ping anyone: `@everyone`, roles and users quoted in an answer are shown but not notified.

## Commands

The bot registers its commands as Discord slash commands when it connects: `/help`, `/models`, `/skills`, `/ctx`, `/workspace`, `/think`, `/reset`, `/stop`, `/id`, `/approve`, `/deny`, `/pair`. Pick one from Discord's command menu; Discord shows "thinking…" until the answer replaces it. A newly registered command can take a minute to appear in the menu.

The same commands also work as typed text. In DMs, type them as they are. In servers, a typed command must mention the bot, so several bots in one channel do not all answer it:

```text
@Morph /models
@Morph /stop
```

## Progress, files and reactions

While a task runs the bot shows "typing…". A planned task gets one plan message that is edited as steps start and finish, and each finished step's note is sent as a message of its own before the final answer. Answers longer than 2,000 characters are split at paragraphs and lines, never inside a code block.

Images sent to the bot are downloaded to `file_cache_dir/discord/` and given to the model. Other attachments are named in the message text with their size, but not downloaded.

Inside a Discord task the agent can use:

```text
message_react       add an emoji reaction to the triggering message
discord_send_file   upload a file from file_cache_dir (up to 10 MB)
```

## Approvals

When a tool needs approval, the bot posts what is asked and why, with **Approve** and **Deny** buttons. Anyone who may use the bot in that conversation can press them, and the decision is recorded as theirs. The message then shows the outcome in place of the buttons. The text commands `/approve <id>` and `/deny <id>` work too; in servers, mention the bot.

## Contacts and Agent pairing

Discord users are stored as `discord_user:<user_id>`, and channels are referenced as `discord:<channel_id>`. `contacts_send` can message a user (through their DM channel, opened when needed) or a channel.

Administrators are configured with a Discord user ID:

```yaml
admins:
  - discord_user:123456789012345678
```

`/pair @Agent` in a DM starts Agent pairing as on the other channels, and the target must already be an active Agent in Contacts. Pairing runs over DMs, and Discord does not let one bot DM another, so pairing two Morph bots that are both on Discord does not complete.

## Current limits

- No streaming: the answer is sent when it is complete.
- Voice and stage channels are not supported. A forum post works as a thread.
- A session that cannot be resumed after a long disconnection misses the messages sent meanwhile; they are not fetched back from channel history.
