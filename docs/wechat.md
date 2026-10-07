# WeChat

Mister Morph can run as a WeChat bot in private chats. It uses Tencent's iLink bot protocol (the one behind the official OpenClaw WeChat plugin): it long-polls for new messages and sends replies over HTTPS. There is no webhook to host.

Only private chats are supported. Group messages are ignored.

## Connect the bot

Log in by scanning a QR code with WeChat, either in a terminal:

```bash
morph wechat login
```

or in Console: Settings → Channels → WeChat → **Connect WeChat**.

The login prints (or shows) a QR code link. Scan it with WeChat and confirm on the phone; if the phone shows a verification code, enter it when asked. On success Morph saves:

- the bot token in the system keyring, referenced from config as `${secret:...}`;
- `wechat.bot_id` and `wechat.base_url` in `config.yaml`.

The token is never written to the config file in plain text. If the system keyring is not available, `morph wechat login` prints the token once so you can set `MISTER_MORPH_WECHAT_BOT_TOKEN` yourself; the Console login refuses instead, since the token must not pass through the browser.

To disconnect and delete the token:

```bash
morph wechat logout
```

or **Disconnect** in the Console pane.

## Configuration

```yaml
wechat:
  bot_token: ""         # written by login; or MISTER_MORPH_WECHAT_BOT_TOKEN
  bot_id: ""            # written by login
  base_url: ""          # written by login; empty uses https://ilinkai.weixin.qq.com
  task_timeout: "0s"
  max_concurrency: 3
  serve_listen: ""
```

There is no allowlist: WeChat lets only the person who scanned the QR code chat with the bot. Send `/id` to the bot to see your WeChat user ID (it looks like `o9cq80...@im.wechat`).

## Start the runtime

```bash
morph wechat
```

The main CLI overrides are:

```text
--wechat-bot-token
--wechat-task-timeout
--wechat-max-concurrency
```

Only one process may poll a bot at a time. A second `morph wechat` (or Console runtime) for the same bot refuses to start, naming the process that holds it; the lock lives under `file_state_dir/locks`.

To expose the standard remote Runtime API, set `wechat.serve_listen` and `server.auth_token`. The API base path is `/runtime`.

## Run it inside Console

```yaml
console:
  managed_runtimes: ["wechat"]
```

or turn on **Run in Console** in the WeChat pane. The WeChat runtime then shares the Console task store, and its connection status shows on the Runtime page. A new login from Console restarts it with the new token.

## Behavior

- Every private message starts a task. A quoted message is passed to the model as a `> ` quote above the text, and a voice message is read through WeChat's own transcript.
- While a task runs the bot shows "typing…".
- Answers are plain text; Markdown is not rendered by WeChat. Answers longer than 4,000 characters are split at paragraphs and lines.
- A planned task does not get a progress message; each finished step's note is sent as a message of its own before the final answer.
- Images are downloaded, decrypted (WeChat's CDN stores media AES-128 encrypted) and saved to `file_cache_dir/wechat/`, then given to the model, up to three per message. Files, videos, and voice messages WeChat did not transcribe are saved there too and named in the message, so the agent can read them with its tools. Files over 50 MB are not downloaded.
- The agent can send a file under `file_cache_dir` with the `send_file` tool: an image or video is sent as one, anything else as a file.
- Commands work as typed text: `/help`, `/models`, `/skills`, `/reset`, `/stop`, `/id`, `/approve <id>`, `/deny <id>`.

## Session expiry

When WeChat ends the bot's session, the runtime stops polling, logs `reauth_needed`, and the Runtime page shows it. Log in again (`morph wechat login`, or **Reconnect** in Console); a Console runtime picks up the new token by itself, a `morph wechat` process needs a restart.

After a restart, messages sent while Morph was down may be delivered again by WeChat; each is still answered only once.

## Heartbeat, cron and contacts

WeChat only accepts a message that carries the context of the user's latest message, and that context lives in the running runtime. So everything sent outside a reply goes through the runtime in the same process (`morph wechat`, or the Console runtime), and reaches only users who have written to the bot since it started:

- `contacts_send` to a `wechat_user:<user_id>` contact, or with `chat_id: wechat:<user_id>`, including files sent with its `path` parameter.
- Cron tasks whose `chat_id` is `wechat:<user_id>`.
- Heartbeat notifications, which `morph wechat` sends when heartbeat is enabled, to you: the runtime remembers who wrote to the bot (in `file_state_dir/accountdm/`), and on WeChat that is only the person who scanned.

WeChat users are stored as `wechat_user:<user_id>`; conversations are keyed `wechat:<bot_id>:<user_id>`.

```yaml
admins:
  - wechat_user:o9cq80...@im.wechat
```

## Current limits

- Private chats only; no groups.
- Voice messages are read through WeChat's transcript only; the SILK audio of an untranscribed one is saved but not converted.
- Messages to a user who has not written since the runtime started cannot be sent.
- No streaming: the answer is sent when it is complete.
