---
date: 2026-10-11
title: "Agent Link: a built-in channel between agents connected to a Console"
status: implemented-v1
---

# Agent Link: a built-in channel between agents connected to a Console

## Goal

Let agents message each other when they share no chat platform. Every agent that a Console connects to as an endpoint, plus the Console's own local agent, joins a virtual built-in channel, Agent Link. Agents reach each other through `agent_send` and the contacts they already use. Replies come back through the normal channel reply path.

Agents never see a runtime API, URL or token. The Console relays messages over connections it already opens to its endpoints.

## Current behavior

- `agent_send` is `contacts_send` limited to active `kind: agent` contacts (`tools/builtin/agent_send.go`). It only reaches an agent that has an account on a platform the sender is connected to (Telegram, Slack, LINE, Lark, Mixin, Discord, WeChat, WhatsApp), and that agent must be listening there.
- A Console holds a URL and bearer token for each endpoint (`console.endpoints`). It polls `/health` every 30s (`consolecmd/serve.go`) and opens per-task WebSocket streams at `<endpoint>/stream/ws`. Connections only go from Console to runtimes; runtimes never connect to a Console.
- `/health` returns `agent_name` (from the persona, `personautil.LoadAgentName`) and `instance_id`. `instance_id` is `sha256(state_dir)` (`daemonruntime/server.go` `buildRuntimeInstanceID`), so two hosts or containers with the same state path report the same ID. Only the Console's Runtime page uses it, and only to display it.
- `contacts.Service` sets `cooldown_until` when a send fails and clears it when a send succeeds (`contacts/service.go` `applySendOutcomeToContacts`). **Nothing reads it.** No send path checks the cooldown.
- The message envelope (`bus.MessageEnvelope`) has `message_id`, `text`, `sent_at`, `session_id` and `reply_to`. Nothing limits how many times agents can reply to each other.

## Design

### 1. Agent identity: a saved `instance_id`

- On first start, a runtime generates a random ID (`inst_` + 128 random bits, hex) and saves it to `<state_dir>/instance_id`. Later starts read it. This replaces `sha256(state_dir)`. Nothing depends on the old value, so no migration is needed.
- The Console's local runtime has its own `instance_id` like any other runtime.
- `/health` keeps returning `instance_id` and `agent_name`.
- Agent Link contact ID: `mm:<instance_id>`. The display name is `agent_name`, refreshed whenever the list of reachable agents changes. Renaming an agent changes only its nickname, never the contact.
- Cloning a state dir also clones its ID. When a second runtime connects to a Console with an `instance_id` already connected, the Console refuses that connection and logs a warning naming both endpoints. The first one stays on Agent Link. Two processes that share one state dir (for example `morph telegram` and `morph slack`) are the same agent, and only one of them joins.

### 2. Reachable agents and contacts

Each Console builds a list of reachable agents from the runtimes connected to its relay: its own local runtime and every endpoint whose `/agentlink/ws` stream is open. Each runtime introduces itself with a `hello` frame carrying `{instance_id, agent_name}`. Endpoints that are down, have no Agent Link route (older versions), or repeat a connected `instance_id` are left out.

The Console sends each runtime the full list when it connects and again whenever the list changes (see §3). A runtime combines the lists of all Consoles connected to it, keyed by `instance_id`, and leaves itself out.

The runtime keeps contacts in sync **automatically, with no approval step**:

- Every agent in the combined list is upserted as an active contact: `contact_id: mm:<instance_id>`, `kind: agent`, `channel: agentlink`, `nickname: <agent_name>`. Upserting at least one makes `agent_send` available, following its existing rule.
- An agent counts as **reachable** while at least one connected Console lists it.
- A contact becomes inactive only when no Console has listed it for `contacts.agent_link.inactive_after` (default `24h`). This keeps contacts stable through Console restarts and network blips. Messages to an agent that is active but not reachable wait in the queue (§4).
- Agent Link contacts are agent contacts like any other. A user can still deactivate one by hand, and the next sync does not reactivate it. The sync remembers which contacts it deactivated itself in `<state_dir>/agentlink/peers.json`, and reactivates only those.

One agent can be in several Consoles' lists. That's the expected case: it's like one person being in two Telegram groups. There is still one contact and one route, `mm:<instance_id>`. Senders never choose a Console.

### 3. Stream: the `/agentlink/ws` route

This is a new WebSocket route on the runtime API, served wherever `/stream/ws` is served (daemonruntime standalone channel processes and the Console's runtime handler). The Console connects with the endpoint's existing bearer token. It's a route between Console and runtime only. No tool calls it, and no agent sees its URL or token.

The Console keeps one Agent Link connection open to each healthy endpoint and reconnects with backoff. The Console's local runtime takes part in-process through the same interface, without a socket.

JSON frames:

| Direction | Frame | Purpose |
|---|---|---|
| runtime → Console | `hello {instance_id, agent_name}` | Identifies the runtime; sent again after a rename |
| Console → runtime | `roster {agents: [{instance_id, agent_name}]}` | Full list of reachable agents, sent on connect and on every change |
| runtime → Console | `send {lease_id, message}` | Asks the Console to deliver one queued message |
| Console → runtime | `send_result {lease_id, message_id, status, reason?}` | `delivered`, `rejected` (target refused it, e.g. hop limit) or `unreachable` |
| Console → runtime | `deliver {message}` | Hands an incoming message to the target runtime |
| runtime → Console | `deliver_result {message_id, status, reason?}` | `accepted` once saved, or `rejected` |
| both | `ping` / `pong` | Keepalive: the Console pings every 30s, and either side drops a connection silent for 90s |
| Console → runtime | `error {reason}` | The Console refuses the connection (`duplicate_instance_id`) |

`message`:

```json
{
  "message_id": "msg_…",
  "from": "inst_…",
  "to": "inst_…",
  "hop": 1,
  "envelope": { "message_id": "msg_…", "text": "…", "sent_at": "…", "session_id": "…", "reply_to": "…" }
}
```

Relaying one message, from A to B:

1. A sends `send` to a Console C whose list includes B.
2. C sends `deliver` to B, and B saves the message, then replies `deliver_result: accepted`.
3. C sends `send_result: delivered` back to A.

### 4. Queue and delivery

- Each runtime has **one** Agent Link queue, addressed by target `instance_id`, saved under the state dir so a restart loses nothing. Queued messages are not tied to any particular Console.
- The runtime hands a message to **one** connected Console whose list includes the target, under a lease (default 30s). While the lease is held, no other Console gets the message.
- Results:
  - `delivered`: the send is complete. The contact's `last_interaction_at` is updated.
  - `rejected`: the send failed for good. The reason goes to the tool result and the logs.
  - `unreachable`, the lease running out, or the connection closing: the message goes back in the queue and may go to a different Console.
- A message still undelivered after `contacts.agent_link.queue_ttl` (default `24h`) fails.
- The receiver ignores repeat `message_id`s (kept for 7 days in `<state_dir>/agentlink/seen.json`), which makes at-least-once delivery safe. A repeat can happen when a Console delivers a message but its confirmation never reaches the sender.
- `agent_send` waits briefly (up to ~10s) for `delivered`. If none arrives, it returns success with `queued: true` in the outcome, so the model doesn't retry and cause a duplicate.

### 5. Routing in `contacts_send` / `agent_send`

- Add `channels.AgentLink = "agentlink"` and the contact constant `contacts.ChannelAgentLink`.
- `contacts.ResolveDecisionChannel` resolves `mm:` contact IDs and chat IDs to `agentlink`. A contact on a platform channel resolves Agent Link last, so contacts that already work don't change behaviour.
- The sync (§2) creates a separate `mm:` contact, so an agent that is also reachable on a platform has two contacts, one per route. Merging them is left for later.
- `contactsruntime.RoutingSender` gets an Agent Link sender that writes to the queue in §4.
- Agent Link carries text only (as `agent_send` does). `contacts_send` with a file to an `mm:` contact is rejected.

### 6. Incoming messages become channel tasks

- The receiving runtime saves the message, ignores it if it's a repeat, and updates the sender contact's `last_interaction_at`. Then it starts an ordinary channel task. Messages in one conversation also pass the existing per-conversation agent limiter (8 per 10 minutes); over it, the message is rejected with `rate_limited`.
- Conversation key: `agentlink:<from_instance_id>:<session_id>`. The task sees the sender as contact `mm:<from>`, with its nickname.
- The task's final reply goes back over Agent Link to `from`, with the same `session_id` and with `reply_to` set to the incoming `message_id`.
- Incoming text is untrusted channel input, handled the same way as Telegram or Slack text. Guard, approval and audit rules apply unchanged.
- Each runtime type that serves `/agentlink/ws` runs such tasks: the Console's local runtime and the standalone channel runtimes. One runner runs per state dir in a process. A host built on the `integration` package serves the route but runs no runner, so messages to it are rejected with `no_handler`.
- A failed task sends nothing back, so an error does not start another agent's task. A task that ends waiting for an approval fails, because no one can approve over Agent Link.
- The task prompt says the message comes from another agent and is untrusted input. `contacts_send` cannot message the same agent during the task; the answer goes back as the reply.

### 7. Loop control: hop count

- Messages carry `hop` (§3). **The runtime sets it, never the model.** Anything the model passes, including inside `message_base64`, is overwritten.
  - A task started by a human, cron, awareness or heartbeat sends with `hop = 1`.
  - A task started by an Agent Link message with hop `h` sends with `hop = h + 1`. This covers both its reply and any `agent_send` it makes.
- The receiver checks `hop > contacts.agent_link.max_hops` (default `6`). If the limit is exceeded, it saves the message to chat history but starts no task, and answers `deliver_result: rejected, reason: hop_limit`.
- The task context carries the hop value, which `agent_send` reads when it builds the message.

### 8. `agent_send` cooldown (fixes the unused `cooldown_until`)

`cooldown_until` exists to rate-limit `agent_send`, but nothing checks it. Changes:

- **Check it:** before planning, `agent_send` and `contacts_send` reject any Agent contact whose `cooldown_until` is later than now, so `contacts_send` cannot get around it. The error gives the time the cooldown ends. If several agents are targeted, the whole call is rejected before anything is sent, which matches the current rule for targets that aren't agents.
- **Set it:** after a successful or queued send to an Agent contact, set `cooldown_until = now + contacts.agent_send.cooldown` (default `30s`; `0` turns it off).
- For agent contacts, a failed send no longer sets the 72h/`failure_cooldown`. Queued Agent Link messages handle temporary unreachability, and a long failure cooldown would cut agents off. Human contacts keep the current failure behaviour.
- Replies through the channel reply path (§6) don't go through `agent_send`, so the cooldown doesn't apply to them. The hop count (§7) limits them.

### 9. Config

Add to `assets/config/config.example.yaml`:

```yaml
contacts:
  agent_link:
    # Join the built-in Agent Link channel when a Console connects to this runtime.
    enabled: true
    # Incoming messages above this hop count are recorded but do not start a task.
    max_hops: 6
    # Undelivered messages fail after this long.
    queue_ttl: "24h"
    # Agent Link contacts become inactive when no Console has listed them for this long.
    inactive_after: "24h"
  agent_send:
    # Minimum interval between agent_send calls to the same Agent contact. 0 disables it.
    cooldown: "30s"
```

The Console needs no new keys: `console.endpoints` already defines the members.

## Trust

- The Console already holds every endpoint's full token, so Agent Link adds no new trust between Console and runtimes. Endpoints that already trust a Console now relay messages through it.
- A Console can see and forge Agent Link messages between its endpoints. This is accepted. Signing messages with a per-runtime keypair can come later without changing the frame format (`instance_id` could become a public-key fingerprint).
- Agents never see URLs, tokens or the route. They only see `mm:` contacts.

## Out of scope

- Files over Agent Link.
- Choosing which Console delivers a message.
- Relays other than a Console (hosted mailboxes, direct runtime-to-runtime connections).
- Agents connected to no Console.

## Open questions

- Channel and prefix names: `agentlink` / `mm:` are working names.
- Should Console show Agent Link traffic (queue, recent deliveries, rejected hops, duplicate IDs) in the side panel for each endpoint? v1 only logs it.
- Should one agent reachable on both a platform and Agent Link have one merged contact instead of two?

## Implementation notes (v1)

- `internal/agentlink`: instance ID (`identity.go`), frames (`protocol.go`), connections (`conn.go`: WebSocket and in-process pipe), the runtime `Node` with its queue (`node.go`), the Console `Relay` (`relay.go`), the WebSocket route (`http.go`), the contact sync (`contactsync.go`) and the hop context (`hop.go`). One `Node` exists per state dir in a process (`agentlink.Shared`).
- `internal/daemonruntime/server_routes_agentlink.go` serves `/agentlink/ws` when `contacts.agent_link.enabled` is on and the runtime API has an auth token. The Console serves it beside `/stream/ws`, outside its generation handler, so a long-lived stream does not hold a generation.
- `cmd/mistermorph/consolecmd/agentlink.go` connects the Console's relay to its own runtime in process and dials each endpoint, reconnecting with backoff from 1s to 5 minutes.
- `internal/channelruntime/agentlink` is the runner (§6). The Console starts it with its awareness loop; the channel runtimes start it with their runtime API.
- `internal/contactsruntime/agentlink.go` sends to `mm:` contacts; `contacts.QueuedDeliveryError` marks a queued send as a success with `queued: true`.
- A one-off `run` has no node, so a send to an `mm:` contact fails with "agent link is not running in this process".

## Implementation steps

1. Saved `instance_id`, plus the Console warning for duplicate IDs.
2. Check and set the `cooldown_until` cooldown for `agent_send` (§8). This is independent of the rest and fixes an existing bug.
3. `/agentlink/ws` route, queue with leases, and repeat-message filtering in the runtime. Relay in the Console, plus the in-process path for its local runtime.
4. Reachable-agent sync into contacts.
5. Agent Link route in `contacts_send`/`agent_send`, and incoming messages becoming tasks, with replies.
6. Hop count.
7. Config template and `docs/tools.md` (`agent_send` section). Tests: table-driven tests for route selection, lease expiry and handing over to another Console, repeat filtering, the hop limit, and cooldown checks.
