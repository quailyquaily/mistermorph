---
date: 2026-11-17
title: "contacts_send found with tool search in ordinary runs"
status: implemented
---

# contacts_send found with tool search in ordinary runs

## Goal

Let an ordinary run (a Console chat, a Telegram or Slack message, the other channel runtimes) send a message or file to a contact when the user asks for it, without putting `contacts_send` in every request. The model finds it with `tool_search` and calls it from the next step.

## Before

- `contacts_send` was registered for awareness runs (heartbeat, cron) when `tools.contacts_send.enabled`, and for a task that named `$contacts_send`.
- Ordinary runs had no `contacts_send`: a request such as "tell Ann the build is green" in a Telegram chat could not be done.
- `contacts_list` and `agent_send` were available in ordinary runs (`agent_send` while an active Agent contact exists).

## Behavior

- Ordinary runs with `tools.contacts_send.enabled` and `tools.tool_search.enabled` (both default on) get `contacts_send` as a deferred tool (`tools.Deferred`). It is not in the first request or the system prompt; `tool_search` finds it by its name or words such as `contacts send`; after that it is an ordinary visible tool for the run and, like any found tool, for the rest of the conversation.
- With tool search off, ordinary runs have no `contacts_send`. A deferred tool is visible from the first request when tool search is off, so registering it there would put it in every request, which is what this change avoids.
- With `tools.contacts_send.enabled: false`, nothing registers it, so search finds nothing. An explicit `$contacts_send` keeps its old meaning: it shows the tool for that task, visible from the start, even when the setting is off.
- Group chats keep their opt-in: in a Telegram group, Slack channel, Discord server channel, LINE or Lark group or Mixin group, `contacts_send` is not registered, so `tool_search` does not find it and a call fails as an unknown tool. A message that names `$contacts_send` still shows it there, as before.
- Awareness runs are unchanged: they build their own registry, where `contacts_send` is visible.
- Subtasks never get it: they run without runtime tools, and `spawn` does not pass hidden tools to them.
- `contacts_list` and `agent_send` are unchanged.

## Design

- The tool is the existing `contacts_send` (`builtin.NewDeferredContactsSendTool` builds the same `ContactsSendTool` with `Deferred()` true). There is no second send tool and no new delivery path: contact resolution, routing, the outbox, credentials, cooldowns and guard checks are the ones awareness uses.
- `taskruntime.prepareRun` is shared by the Console, every channel runtime, the CLI and the embedding runtime. It already calls `RegisterTriggeredStaticTools` for every run. With tool search on and no `contacts_send` in the run's registry, it adds the trigger `toolsutil.SearchableContactsSendTrigger`, and `toolsutil.RegisterStaticTools` registers the deferred tool when the setting is on. The trigger is not a tool name, so a `$` reference in a task cannot set it.
- Channels remove `contacts_send` from a group chat's registry, and they set `RunRequest.ContactsSendOptIn` for those runs, so `prepareRun` does not add the trigger back. Only `$contacts_send` (or a channel's own trigger, such as an agent's private message) registers it there.
- Every runtime's `RegisterTriggeredStaticTools` closes over its own static tool config (selected built-ins, tokens, contacts and state folders), so the deferred tool gets the same configuration as the awareness one, and an embedder's built-in tool selection still applies.
- The tool's description now names every route it can use, says that `contacts_list` lists contact IDs, that a prefixed `contact_id` (`tg:`, `slack:`, ...) sends only on that channel, and how a failure looks.

## Safeguards kept

- The runtime's current-conversation block (`builtin.WithContactsSendRuntimeContext`) still refuses a send to the person the run is talking to.
- Unknown contacts, contacts without a reachable route and a `chat_id` that does not match the contact fail with an error before anything is sent.
- A delivery the channel rejects (a missing channel credential, a blocked bot) returns `outcome.accepted: false` with `outcome.error`, as before; nothing reports it as delivered. This result shape is unchanged so awareness and cron keep their behavior.
- Guard rules and approvals apply by tool name, the same as before; finding a tool does not authorize it.

## Tests

- `internal/toolsutil`: registration matrix (ordinary, disabled, awareness, explicit `$contacts_send`, selected built-ins).
- `internal/channelruntime/taskruntime/contacts_send_search_test.go`: real runs through `Runtime.Run` with a scripted model and a fake Telegram Bot API: absent at first, found by `contacts send` and `contacts_send`, delivered through the existing sender, not callable before it is found, absent with tool search off or the setting off, explicit `$contacts_send` still visible, and blocked, unknown, invalid and undeliverable recipients.
- Group chats, through each channel's own task function (`runTelegramTask`, `runSlackTask`, `runDiscordTask`, `runLineTask`, `runLarkTask`, `runMixinTask`) and `internal/channelruntime/runtimetest.CheckContactsSendOptIn`: in a group without `$contacts_send` a model that searches for `contacts_send` and calls it anyway finds nothing and sends nothing; with `$contacts_send` it is visible and delivers; a direct chat finds it with `tool_search` and delivers.
- Runtime wiring, through `internal/channelruntime/runtimetest.DiscoverContactsSend`: Console chat and Console-managed channel runtimes (`cmd/mistermorph/consolecmd`), channel config generations (`internal/channelruntime/depsutil`), the `telegram`/`slack` commands (`cmd/mistermorph`), and the embedding runtime's Telegram and Slack bots (`integration`).
