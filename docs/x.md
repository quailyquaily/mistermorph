# X

Mister Morph can run an X (Twitter) account. It answers the account's direct messages and, once X approves it, posts that mention the account, in the thread. It polls the X API v2; there is no webhook to host. See the [design](feat/feat_20261011_x_bluesky_channels.md).

**Every X API call is billed** to your app's prepaid credits (pay-per-use; there is no free tier for new developers). At the time of writing: $0.015 per post, $0.20 per post with a link, $0.005 per post read, $0.010 per direct message read and $0.015 per direct message sent; X does not bill the same resource twice in a UTC day. Check X's pricing page before you start, and set a spending limit in the Developer Console.

## Prepare the account and the app

X has no separate kind of bot account. Use an ordinary account made for the agent, not your own:

1. Create the account, and turn on X's **Automated** label in its settings, naming your own account as the managing account. Say in its bio that it is a bot and who runs it. X's developer guidelines require all three.
2. In the [X Developer Console](https://developer.x.com), create an app with OAuth 2.0 user authentication (a public or a confidential client), and add `http://127.0.0.1:8765/x/callback` as a callback URL. Buy credits.
3. Set `x.client_id` (and, for a confidential app, `MISTER_MORPH_X_CLIENT_SECRET`), then log in, **signed in to X as the agent's account**:
   - In Console: Settings → Channels → X → **Log in to X**. X's page opens in a new tab; approve, and the pane shows the account. The browser must run on the Console's machine, since X sends it back to `127.0.0.1:8765`.
   - Or in a terminal: `morph x login`, then open the printed URL. On a headless machine, run it there (with an SSH tunnel for port 8765, or a browser on that machine).

   The login is kept in `file_state_dir/auth/x.json`, beside the other logins. X rotates the refresh token on every use; the runtime saves each new one there, so nothing needs copying into config. `morph x logout` (or **Log out** in the pane) forgets it.

   `x.refresh_token` (or `MISTER_MORPH_X_REFRESH_TOKEN`) is only for setups that cannot run the login: a token set there is used instead of the saved login.

### Mentions need X's approval

X's developer guidelines require approval **before** an app posts AI-generated replies; request it through X's Policy Support form. Until then keep `x.mentions.enabled: false` (the default). Direct messages that people send first are allowed without it.

## Configuration

```yaml
x:
  client_id: ""
  client_secret: ""                 # or MISTER_MORPH_X_CLIENT_SECRET
  refresh_token: ""                 # optional; normally the saved login is used
  owners: ["@you"]                  # heartbeat notifications go to them
  dm:
    enabled: true
    poll_interval: "60s"
    allowed_user_ids: []            # user IDs or @usernames; empty allows anyone
  mentions:
    enabled: false
    poll_interval: "120s"
    allowed_user_ids: []
    blocked_user_ids: []
    thread_context_depth: 3
    max_reply_posts: 3
    max_posts_per_day: 50
    allow_links_in_posts: false
  task_timeout: "0s"
  max_concurrency: 3
  serve_listen: ""
```

**Set `dm.allowed_user_ids` on a public account.** Whoever may message the agent can start tasks and approve its tool calls. @usernames are resolved to IDs at start (each lookup is billed).

## Start the runtime

```bash
morph x
```

The main CLI overrides are `--x-refresh-token` (instead of the saved login), `--x-task-timeout` and `--x-max-concurrency`. Only one process may serve an account at a time. To run it inside Console, add `x` to `console.managed_runtimes`, or turn on **Run in Console** in the X pane; the Runtime page shows its status, and the runtime overview reports the day's calls by kind (`x_usage`).

When X refuses the login the status becomes `reauth_needed` (log in again); when the credits run out it becomes `out_of_credits`. Either way polling slows to every 15 minutes until it works again.

## Direct messages

- The latest direct messages are polled every `dm.poll_interval`; each new one from someone allowed starts a task, with the same commands, approvals and history as the other private-chat channels.
- X lets an automated account message only people who messaged it first. Morph remembers who wrote (in `file_state_dir/x/state.json`) and refuses a `contacts_send` or notification to anyone else.
- At start, messages from the last 24 hours that were not answered are answered.
- Messages are plain text. Files cannot be sent.

## Public mentions

- The first poll only records where to start: mentions made before the channel first ran are never answered.
- A mention starts a task that reads up to `thread_context_depth` posts above it (one billed lookup per post) and the mention's photos.
- Only the final answer is posted, as a reply chain of at most `max_reply_posts` posts of 280 weighted characters (CJK characters count double); a longer answer is cut with "…". Errors, commands, approvals and plan progress are never posted.
- With `allow_links_in_posts: false`, URLs are removed from the answer before it is posted, since a post with a link costs over 13 times as much. X still turns a bare domain into a link.
- `max_posts_per_day` caps posts in a UTC day; an answer that would go over it is not posted (the task fails with that reason).
- Not answered: the agent's own posts, `blocked_user_ids`, users outside `allowed_user_ids` when set, and anyone who opted out by posting only "stop" (until they post "start").

## Heartbeat, cron and contacts

- People who message the agent become contacts `x_user:<user_id>`; `contacts_send` and `agent_send` to them send a direct message.
- Cron tasks may target `chat_id: x:<user_id>`.
- Heartbeat notifications go to `owners`, who must have messaged the agent once.

## Current limits

- No group conversations, files or images in messages or replies.
- No unprompted posts.
- X opened an encrypted "X Chat" API in mid-2026; whether conversations moved there are still returned by the classic direct-message endpoints Morph uses has not been tested.
