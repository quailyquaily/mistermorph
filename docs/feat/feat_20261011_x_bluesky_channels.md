---
date: 2026-10-11
title: X and Bluesky Channels
status: implemented-v1
---

# X and Bluesky Channels

## 1. Goal

Add two channels, `x` (X, formerly Twitter) and `bluesky`, so that people can talk to a Morph agent there:

- **Direct messages:** a private conversation, like WeChat and WhatsApp today.
- **Public mentions:** someone mentions the agent's account in a post, and the agent answers in that thread.

Both channels use the shared task runtime: commands, approvals, contacts, `agent_send`, cron targets and the Console's
managed runtimes, as the other channels do.

## 2. Accounts: there is no "bot account" type

Neither platform has a separate kind of bot account, as Telegram, Discord or Slack do. **A Morph agent runs as an
ordinary account, created for it alone**, and each platform has a way to mark it as automated.

### 2.1 X

- Create a dedicated, normal X account for the agent. Do not use a person's own account: X's rules are applied to the
  account, and enforcement can suspend it.
- Turn on the **Automated** label, which shows under the account's name and links it to a **managing account** run
  by a person. X's developer guidelines require every automated account to carry the label, to say in its bio that it
  is a bot and who runs it, and to be tied to a human-managed account.
- Register an app in the X Developer Console, and authorize it **as the agent's account** (user context). Posting,
  reading mentions and DMs all act as that account.

### 2.2 Bluesky

- Create a dedicated, normal Bluesky account (any PDS; `bsky.social` by default).
- Add the self-label `bot` to its profile, as Bluesky's bot guidance asks.
- Log in with an **app password**, never the account password. Tick "Allow access to your direct messages" when
  creating it, or chat calls fail.

## 3. Platform facts

### 3.1 X

**Cost (pay-per-use, from X's pricing page, checked 2026-10-11).** There is no free tier for new developers. Credits
are bought ahead and drawn down per call.

| Resource | Price |
| --- | --- |
| Post create | $0.015 per request |
| Post create with a URL | $0.200 per request |
| Post create, summoned (a reply where the author mentioned the account) | $0.010 per request |
| Post read | $0.005 per resource |
| Own reads (for example the account's own mentions) | $0.001 per resource |
| User read | $0.010 per resource |
| DM event read | $0.010 per resource |
| DM event create | $0.015 per request |

- A resource already charged is not charged again within the same UTC day.
- Post reads are capped at 3 million per billing cycle; a spending limit can be set per cycle.
- A post with a link costs over 13 times as much as one without. The channel has to know this (section 6.4).

**Rules for automated accounts** (X developer guidelines):

- Reply only when the user engaged first, once per interaction. No unsolicited @mentions.
- DM a user only after they have sent a DM first, and offer an easy opt-out. "Stop" must stop it.
- No automatic likes or follows.
- **AI-generated replies need X's approval before launch**, through X's Policy Support form. This applies to Morph
  directly: every reply is AI-generated. Without approval, the public-mention mode is at risk; DMs that the user
  starts are the safer start.

**API shape:**

- Auth: OAuth 2.0 with PKCE as the agent's account, scopes `tweet.read tweet.write users.read dm.read dm.write
  offline.access`; tokens are refreshed with the refresh token. (OAuth 1.0a user tokens also work; we pick one.)
- Mentions: poll `GET /2/users/{id}/mentions` with `since_id`. Webhooks (Account Activity API) need a public URL,
  which a desktop install does not have, so v1 polls.
- DMs: poll `GET /2/dm_events`, send with `POST /2/dm_conversations/with/{participant_id}/messages`.
- A post holds 280 weighted characters (CJK characters count double); a DM holds far more.
- **To check:** X opened an encrypted "X Chat" API in mid-2026. Whether the classic `dm_events` endpoints still reach
  conversations that moved to encrypted chat must be tested with real accounts before building the DM transport.

### 3.2 Bluesky

**Cost:** none. Writes are limited per account by points (a third-party source gives 5,000 per hour and 35,000 per
day, 3 points per record created; to check against Bluesky's rate-limit page). Logins are limited far more tightly,
so the session must be kept and refreshed, not created per call.

**Rules** (Bluesky bot guidance): label the account; interact only when the user tagged the bot ("opt-in"); respect
the rate limits.

**API shape (AT Protocol, XRPC over HTTPS):**

- Session: `com.atproto.server.createSession` with the handle and app password gives an access and a refresh token;
  `com.atproto.server.refreshSession` renews it. Requests go to the account's PDS.
- Mentions and replies: poll `app.bsky.notification.listNotifications` (reasons `mention`, `reply`, `quote`), and
  mark them seen with `updateSeen`. The firehose or Jetstream is the push alternative, but it carries the whole
  network; v1 polls.
- Posting: create an `app.bsky.feed.post` record with `com.atproto.repo.createRecord`. A reply carries `reply.root`
  and `reply.parent` (URI and CID). Mentions and links are **facets** with UTF-8 byte offsets. A post holds 300
  graphemes.
- Direct messages: the `chat.bsky.convo.*` methods, sent to the PDS with the proxy header naming the chat service
  (`did:web:api.bsky.chat#bsky_chat`). `listConvos` (with `readState=unread`) and `listConvoRequests` list the
  conversations with something new, `getMessages` reads one, `updateRead` marks it read and `acceptConvo` accepts a
  request; `getConvoForMembers` finds or opens the conversation with a user; `sendMessage` sends (at most 1,000
  graphemes). `getLog` is the event stream alternative.
- A user can allow DMs from everyone, from people they follow, or from no one. The agent can only DM someone who
  allows it.

## 4. Scope and parity

| Capability | X v1 | Bluesky v1 | Notes |
| --- | --- | --- | --- |
| Direct messages | Yes | Yes | Through the shared `accountdm` engine (section 5) |
| Public mentions, answered in the thread | Yes, after X approves AI replies | Yes | New `socialpost` mode (section 6) |
| Unprompted posts (cron "post this") | Later | Later | Needs its own approval and cost rules |
| Allowlists | Yes | Yes | Users who may DM; users whose mentions are answered |
| One run per conversation | Yes | Yes | |
| History, sticky skills, context checkpoints | Yes | Yes | Shared task runtime |
| Shared slash commands | DM only | DM only | Not in public threads |
| Approvals | DM only | DM only | A public thread cannot hold an approval prompt |
| Image input | Yes | Yes | From post or DM media |
| File output | Images only | Images only | Neither DM nor post carries arbitrary files |
| `contacts_send` / `agent_send` | DM only | DM only | Never as an unsolicited public post |
| Reactions, typing indicator | No | No | Not offered to apps (Bluesky chat has reactions; later) |
| Plan progress, step messages | DM only | DM only | A public thread gets only the final answer |
| Managed runtime in the Console | Yes | Yes | `console.managed_runtimes: [x, bluesky]` |

## 5. Direct messages: an `accountdm` transport each

`internal/channelruntime/accountdm` already runs private conversations for WeChat and WhatsApp behind one
`Transport` interface: `Run` (poll and deliver), `SendText`, `SendFile`, `Typing`, `MaxTextLength`, `MaxFileBytes`
and `Overview`. X and Bluesky DMs fit it:

| Transport method | X | Bluesky |
| --- | --- | --- |
| `Run` | Poll `dm_events`, newest after the stored last event ID | Poll unread `listConvos` and `listConvoRequests`, then `getMessages`, then `updateRead` |
| `SendText` | `POST /2/dm_conversations/with/{id}/messages` | `getConvoForMembers`, then `sendMessage` |
| `SendFile` | Not supported in v1 | Not supported in v1 (chat carries text and embeds) |
| `Typing` | No-op | No-op |
| `MaxTextLength` | 10,000 | 1,000 |

- Poll intervals are set in config. On X every poll is billed, so its default is slower (60s for DMs) than
  Bluesky's (10s).
- X's last event ID is stored in the state dir; Bluesky marks conversations read. The accountdm inbox drops a message
  already answered, so a restart neither answers twice nor skips messages from the last day.
- X allows a DM only after the user wrote first. The transport rejects an outbound DM (from `contacts_send` or cron)
  to someone who never wrote, with an error saying why.

## 6. Public mentions: a new `socialpost` mode

Public posts are not private chats: a thread is shared, anyone can join it, and every reply is public. They need a
small new runtime beside `accountdm`, used by both channels.

### 6.1 Trigger

- Only a post that mentions the agent's account, or replies to one of its posts, starts a task. Nothing else is
  answered, as both platforms require.
- Posts from accounts on a `blocked_user_ids` list, and from the agent itself, are ignored. If
  `allowed_user_ids` is set, only those users are answered.
- A user who writes "stop" (or a configured set of words) is added to an opt-out list kept in the state dir and is
  not answered again until they write "start".

### 6.2 Conversation

- Conversation key: the thread's root post (`x_thread:<root_post_id>`, `bluesky_thread:<root_uri>`).
- The task sees the thread above the mention (parent posts, up to a configured depth) as history, read from the API.
  On X each post read is billed, so the depth is small by default.
- The prompt says the reply is **public**, will be read by anyone, and must fit the post limit.

### 6.3 Reply

- The final answer is posted as one reply to the mention. If it is longer than one post, it is split into a short
  thread of at most `max_reply_posts` posts (default 3), each a reply to the previous one.
- Mentions and links in the text become facets on Bluesky. On X they are left as written.
- No plan progress, step messages, approvals or files in public. A task that needs an approval fails, and the reply
  says the request cannot be done in public.

### 6.4 Cost guard (X)

- `x.max_posts_per_day` caps replies; above it, mentions are recorded but not answered.
- A reply with a URL costs $0.20 on X. `x.allow_links_in_posts` (default `false`) controls whether the agent may post
  one; when off, the prompt asks for no links, and a URL left in the answer is written without a scheme so that it
  is not a link.
- The runtime overview in the Console shows the day's X usage: posts read, posts created, DMs.

## 7. Configuration

```yaml
x:
  # OAuth 2.0 client ID of the X app. Prefer env var: MISTER_MORPH_X_CLIENT_ID
  client_id: ""
  # OAuth 2.0 client secret (confidential clients). Prefer env var: MISTER_MORPH_X_CLIENT_SECRET
  client_secret: ""
  # The agent account's refresh token, written by `morph x login`. Prefer env var: MISTER_MORPH_X_REFRESH_TOKEN
  refresh_token: ""
  base_url: "https://api.x.com/2"
  dm:
    enabled: true
    poll_interval: "60s"
    # Empty allows DMs from anyone who can DM the account.
    allowed_user_ids: []
  mentions:
    # Off until X has approved AI-generated replies for the app (section 3.1).
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

bluesky:
  # The PDS that hosts the account.
  service_url: "https://bsky.social"
  # Handle or DID of the agent's account.
  identifier: ""
  # App password with DM access. Prefer env var: MISTER_MORPH_BLUESKY_APP_PASSWORD
  app_password: ""
  dm:
    enabled: true
    poll_interval: "10s"
    allowed_user_ids: []
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

- Secrets come from env vars first and are never returned by the Console API, like the other channels' tokens.
- `morph x login` runs the OAuth 2.0 PKCE flow once (a local redirect on `127.0.0.1`) and stores the refresh token.
  The Console takes the resulting refresh token in its channel settings (v1 has no login flow in the Console).
- Both channels also take `owners`: who gets heartbeat notifications. WeChat and WhatsApp treat whoever wrote as the
  owner; on these channels anyone may write.
- `assets/config/config.example.yaml`, the config defaults, the Console settings fields and the docs get the same
  keys.

## 8. Identity and contacts

| Object | Morph reference |
| --- | --- |
| X user | `x_user:<user_id>` |
| X public thread | `x_thread:<root_post_id>` |
| Bluesky user | `bluesky_user:<did>`, with the DID's colons written as dots (`did.plc.abc`) |
| Bluesky DM chat_id | `bluesky:<did>` (same form) |
| X DM chat_id | `x:<user_id>` |
| Bluesky public thread | `bluesky_thread:<root_uri>` |
| Bus and chat history channel | `x`, `bluesky` |

- User IDs are the stable ones (X numeric ID, Bluesky DID), never the handle, which can change. The handle and
  display name are kept as the contact's nickname and refreshed when seen.
- Conversation keys of the account channels cannot hold `:`, which a DID does, so Morph writes a DID's first two
  colons as dots everywhere it is an ID; the Bluesky client turns it back.
- `contacts.Contact` gains `XUserID` and `BlueskyUserID`. `contacts_send` to such a contact sends a DM, never a public
  post.
- An account with the Bluesky `bot` self-label is not answered in public, nor in DMs unless allowlisted, so two
  agents cannot answer each other in a loop; agent-to-agent talk goes through allowlisted DMs or Agent Link. X's API
  does not expose the Automated label, so on X this rests on the allowlists.
- Global `admins` accepts `x_user:<id>` and `bluesky_user:<did>`.

## 9. Phases

1. **Bluesky DMs:** session handling, conversation polling, `sendMessage`, contacts. No cost and no approval needed, so
   it is the quickest way to prove the shape.
2. **Bluesky mentions:** the `socialpost` mode, facets, threads, the opt-out list.
3. **X DMs:** OAuth login, `dm_events` polling, the first-DM rule, usage counters. Test the encrypted-chat question
   (section 3.1) first.
4. **X mentions:** after X approves AI-generated replies for the app; the cost guard.
5. Later: unprompted posts from cron, Bluesky chat reactions, images in Bluesky DMs.

## 10. Open questions

- Which X auth to use. Decided: OAuth 2.0 PKCE; the rotating refresh token is saved in the state dir.
- Do X's classic DM endpoints still reach conversations in the new encrypted X Chat? To test with real accounts.
- Bluesky's rate-limit figures, to confirm against the official pages. (The DM limit is 1,000 graphemes, from the
  `messageInput` lexicon.)
- Should a public reply be held for approval by the owner in the Console before it is posted? That would make X's
  "AI replies" approval easier to get, at the cost of slow replies. Proposed as an option, `mentions.review: true`.

## 11. Implementation notes (v1)

- All phases 1 to 4 are built; none was run against the real services. The clients are tested against fake servers.
- `internal/blueskyapi`, `internal/xapi`: the clients. `internal/channelruntime/socialpost`: the public-mention
  runtime. `internal/channelruntime/bluesky`, `internal/channelruntime/xchannel`: the channels.
  `cmd/mistermorph/blueskycmd`, `cmd/mistermorph/xcmd`: `morph bluesky`, `morph x`, `morph x login`.
- On X the first mention poll only records `since_id`; mentions from before the channel first ran are never answered.
- With links off, URLs are removed from a public reply before it is posted. X still links bare domains.
- An answer that would pass `max_posts_per_day` is not posted, and its task fails with that reason.
- Not built: `mentions.review`, a Console login flow for X, files in DMs, unprompted posts, and the `integration`
  package's bot constructors.

## 12. Sources

- X API overview and pricing: <https://docs.x.com/x-api/introduction>, <https://docs.x.com/x-api/getting-started/pricing>
  (checked 2026-10-11)
- X developer guidelines (automated accounts, replies, DMs, AI replies): <https://docs.x.com/developer-guidelines>
- X automation rules and automated account labels: <https://help.x.com/en/rules-and-policies/x-automation>,
  <https://help.x.com/using-x/automated-account-labels> (not readable from here; summarized from the developer
  guidelines)
- Bluesky bots guidance: <https://docs.bsky.app/docs/starter-templates/bots>
- AT Protocol chat lexicon `chat.bsky.convo.getLog`:
  <https://github.com/bluesky-social/atproto/blob/main/lexicons/chat/bsky/convo/getLog.json>
- Bluesky chat endpoints and service proxying: <https://docs.bsky.app/docs/api/chat-bsky-convo-get-convo>
- App passwords with DM access (third-party): <https://atp.readthedocs.io/en/latest/dm.html>
