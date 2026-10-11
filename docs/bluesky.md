# Bluesky

Mister Morph can run a Bluesky account. It answers the account's direct messages, and posts that mention the account or reply to it, in the thread. It polls Bluesky over HTTPS; there is no webhook to host. See the [design](feat/feat_20261011_x_bluesky_channels.md).

## Prepare the account

Bluesky has no separate kind of bot account. Use an ordinary account made for the agent, not your own:

1. Create the account (on `bsky.social`, or on your own PDS).
2. Label it as a bot: Bluesky asks automated accounts to carry the `bot` self-label on their profile. Morph does not answer other accounts that carry it, so two agents never answer each other in public.
3. Create an **app password** (Settings → Privacy and security → App passwords) and tick **Allow access to your direct messages**. Without that box, direct messages fail.
4. Keep the app password out of the repository: put it in Console (Settings → Channels → Bluesky), where it is stored in the system keyring, or set `MISTER_MORPH_BLUESKY_APP_PASSWORD`.

## Configuration

```yaml
bluesky:
  service_url: "https://bsky.social"
  identifier: "agent.bsky.social"   # handle or DID of the agent's account
  app_password: ""                  # or MISTER_MORPH_BLUESKY_APP_PASSWORD
  owners: ["you.bsky.social"]       # heartbeat notifications go to them
  dm:
    enabled: true
    poll_interval: "10s"
    allowed_user_ids: []            # handles or DIDs; empty allows anyone
  mentions:
    enabled: true
    poll_interval: "30s"
    allowed_user_ids: []
    blocked_user_ids: []
    thread_context_depth: 6
    max_reply_posts: 3
  task_timeout: "0s"
  max_concurrency: 3
  serve_listen: ""
```

**Set `dm.allowed_user_ids` on a public account.** Whoever may message the agent can start tasks, and can approve its tool calls with `/approve`. Handles in the lists are resolved to DIDs at start.

## Start the runtime

```bash
morph bluesky
```

The main CLI overrides are `--bluesky-identifier`, `--bluesky-app-password`, `--bluesky-task-timeout` and `--bluesky-max-concurrency`.

Only one process may serve an account at a time; a second one refuses to start, naming the process that holds the lock (under `file_state_dir/locks`). The session is kept in `file_state_dir/auth/bluesky.json`, beside the other logins, and refreshed, since Bluesky limits logins far more than other calls.

To expose the standard Runtime API, set `bluesky.serve_listen` and `server.auth_token` (served while `dm.enabled` is on). To run it inside Console, add `bluesky` to `console.managed_runtimes`, or turn on **Run in Console** in the Bluesky pane.

## Direct messages

- Unread conversations and message requests are polled every `dm.poll_interval`. A request is accepted only from someone allowed to message the agent; the conversation is then marked read.
- Each message starts a task, with the same commands, approvals, plan step messages and history as the other private-chat channels (WeChat, WhatsApp).
- Messages are plain text up to 1,000 characters; longer answers are split. Links and @mentions in the answer become links. Files cannot be sent.
- At start, unread messages from the last 24 hours are answered; older ones are only marked read. Each message is answered once.

## Public mentions

- A post that mentions the account, replies to one of its posts, or quotes it starts a task. Nothing else is answered.
- The task reads up to `thread_context_depth` posts above the mention, and the images of the mention.
- Only the final answer is posted, as a reply in the thread, split into at most `max_reply_posts` posts of 300 characters; a longer answer is cut with "…". Errors, commands, approvals and plan progress are never posted. A request that needs an approval gets a short "can't do that in a public reply".
- Not answered: the agent's own posts, accounts with the `bot` label, `blocked_user_ids`, users outside `allowed_user_ids` when it is set, and anyone who opted out. Someone who posts only "stop" (with the mention) is not answered again until they post "start".
- State (posts handled, opt-outs) is kept in `file_state_dir/socialpost/bluesky.json`.

## Heartbeat, cron and contacts

- People who message the agent become contacts `bluesky_user:<did>`, with the DID's colons written as dots (`bluesky_user:did.plc.abc123`). `contacts_send` and `agent_send` to them send a direct message.
- Cron tasks may target `chat_id: bluesky:<did>`.
- Heartbeat notifications go to `owners` by direct message.

```yaml
admins:
  - bluesky_user:did.plc.abc123
```

## Current limits

- No group conversations.
- No files or images in messages or replies.
- No unprompted posts.
