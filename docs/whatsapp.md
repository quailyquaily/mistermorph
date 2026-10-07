# WhatsApp

Mister Morph can run as a WhatsApp agent over WhatsApp's Agent Platform (v1). An agent created in WhatsApp chats privately with the person who created it; Morph long-polls the agent's updates and sends replies over HTTPS. There is no webhook to host.

This is not the Cloud API for business numbers, and not a linked WhatsApp Web device: the agent has no phone number of its own and does not join groups.

## Create the agent

1. In WhatsApp, create an agent (Settings → Agents).
2. Open the chat with the agent, then **Chat info → API key**, and copy the key.
3. Keep the key out of the repository. Put it in Console (Settings → Channels → WhatsApp), where it is stored in the system keyring, or set `MISTER_MORPH_WHATSAPP_API_TOKEN`.

## Configuration

```yaml
whatsapp:
  api_token: ""   # or MISTER_MORPH_WHATSAPP_API_TOKEN
  task_timeout: "0s"
  max_concurrency: 3
  serve_listen: ""
```

There is no allowlist: the platform only delivers messages from the agent's creator.

## Start the runtime

```bash
morph whatsapp
```

The main CLI overrides are:

```text
--whatsapp-api-token
--whatsapp-task-timeout
--whatsapp-max-concurrency
```

Only one process may poll an agent at a time. A second `morph whatsapp` (or Console runtime) with the same key refuses to start, naming the process that holds it; the lock lives under `file_state_dir/locks`. If something outside Morph polls with the same key, WhatsApp hands the updates to the newer poller and the runtime stops with an error.

To expose the standard remote Runtime API, set `whatsapp.serve_listen` and `server.auth_token`. The API base path is `/runtime`.

## Run it inside Console

```yaml
console:
  managed_runtimes: ["whatsapp"]
```

or turn on **Run in Console** in the WhatsApp pane. The runtime then shares the Console task store, and the Runtime page shows its connection status.

## Behavior

- Every message starts a task; the final answer quotes the message it answers.
- Answers use WhatsApp formatting (`*bold*`, `_italic_`, `~strikethrough~`, ```` ``` ```` for monospace), not Markdown. Answers longer than 4,096 characters are split at paragraphs and lines.
- A planned task does not get a progress message, and messages are never edited; each finished step's note is sent as a message of its own before the final answer.
- No "typing…" indicator: the platform only offers it together with a read receipt.
- Images and stickers are downloaded (their SHA-256 checked) to `file_cache_dir/whatsapp/` and given to the model, with the caption as the message text. Documents, videos and audio, voice notes included, are saved there too and named in the message; voice notes are not transcribed. Reactions are ignored.
- The agent can send a file under `file_cache_dir` with the `send_file` tool: as an image, video, audio or document by its type. Images are limited to 5 MB (a larger one goes as a document) and everything else to 16 MB.
- Commands work as typed text: `/help`, `/models`, `/skills`, `/reset`, `/stop`, `/id`, `/approve <id>`, `/deny <id>`.

The platform allows about 12 sends a minute, and 12 calls a minute to each media method. Sends refused for rate or capacity are retried up to three times; a send whose outcome is unknown (a server error or timeout) is not retried, so a message is never sent twice.

## Restarts and a rejected key

At start the runtime reads the updates WhatsApp still holds and answers those from the last 24 hours that it has not answered before; older ones are skipped. Each message is answered once.

When WhatsApp rejects the key, the runtime stops polling, logs `reauth_needed`, and the Runtime page shows it. Copy a new key from Chat info, save it in Console (the Console runtime restarts with it) or update the environment and restart `morph whatsapp`.

## Heartbeat, cron and contacts

Messages sent outside a reply go through the runtime in the same process (`morph whatsapp`, or the Console runtime), so they share its rate limit:

- `contacts_send` to a `whatsapp_user:<user_id>` contact, or with `chat_id: whatsapp:<user_id>`, including files sent with its `path` parameter.
- Cron tasks whose `chat_id` is `whatsapp:<user_id>`.
- Heartbeat notifications, which `morph whatsapp` sends when heartbeat is enabled, to the agent's creator. The runtime remembers the creator once they have written (in `file_state_dir/accountdm/`), so notifications keep working after a restart.

WhatsApp users are stored as `whatsapp_user:<user_id>`; conversations are keyed `whatsapp:<agent_id>:<user_id>`. Send `/id` to see the IDs.

```yaml
admins:
  - whatsapp_user:1234567890
```

## Current limits

- One private chat with the agent's creator; no groups.
- Voice notes are saved but not transcribed.
- No streaming: the answer is sent when it is complete.
