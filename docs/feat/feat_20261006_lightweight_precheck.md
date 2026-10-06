---
date: 2026-10-06
title: "Lightweight reply pre-check: let the decision route decide on emoji-only replies"
status: implemented-v1
---

# Lightweight reply pre-check: let the decision route decide on emoji-only replies

## Goal

When the decision route points to its own fast profile, use it before the main loop to decide whether a message needs only an emoji reaction:

- Yes: the decision profile picks the emoji and reacts. The main loop does not start.
- No: hand the message to the main loop, with the lightweight-reply rules removed from its prompt, since the decision route has already made that call.

Messages like "OK" or "thanks" then no longer wait for a full main-model turn, so the reply comes much sooner. The main loop also stops carrying the "should I just react?" judgment.

Related:

- [Group reply decision on Evaluate and the decision route](feat_20260922_group_decision_evaluate.md)
- [Other fits for the decision route](feat_20261005_decision_route_fits.md)

## Current behavior

The lightweight decision is made in one of two places, depending on the message.

| Message | Who decides "emoji only" | Who picks the emoji |
| --- | --- | --- |
| Group, no explicit mention, mode `smart` / `talkative` | Decision route (the Evaluate `reply` question: `text` or `emoji`, and `emoji` for which one) | Decision route. `finishDecision` runs the reaction and the main loop is skipped |
| Group, explicit mention or reply to the bot | Main loop (`grouptrigger.Decide` returns early on explicit triggers without calling the decision route) | Main loop, via `message_react` |
| Private chat | Main loop | Main loop, via `message_react` |

The main loop's lightweight rules come from:

- `agent/prompts/system.md:104`: the `reaction` and `is_lightweight` fields of the final JSON.
- `agent/prompts/system.md:111-112`: "use `message_react` for a lightweight acknowledgement, otherwise don't".
- Channel prompt blocks: the `message_react` and reaction-only rules in `internal/promptprofile/prompts/block_telegram.md`, `block_slack.md`, `block_discord.md` and `block_lark.md`.

### Current flow

```
                         inbound message
                               |
              +----------------+-----------------+
              |                                  |
          group chat                        private chat
              |                                  |
     explicit mention / reply?                   |
        |              |                         |
       yes             no                        |
        |              |                         |
        |     mode smart / talkative?            |
        |        |             |                 |
        |       yes            no --> ignore     |
        |        |                               |
        |   [decision route: Evaluate]           |
        |   confidence / interject / reply       |
        |        |                               |
        |   +----+--------------+                |
        |   |                   |                |
        |  reaction           text               |
        |   |                   |                |
        |  react, done          |                |
        |  (skip main loop)     |                |
        |                       |                |
        +-----------+-----------+----------------+
                    |
                    v
   [main loop: system prompt WITH lightweight rules]
     - final.is_lightweight
     - "IF lightweight THEN message_react"
     - channel block reaction rules
                    |
          +---------+----------+
          |                    |
     lightweight              text
     message_react         publish text
```

Problems:

1. Private chats and explicit mentions always use the main model to decide on emoji-only replies. Even when the answer is just 👍, the user waits for a full main-model turn.
2. After the group check has chosen `text`, the main loop still carries the lightweight rules. It can decide "lightweight" again, or add a reaction on top of the text (`docs/telegram.md:252` lists the double-reaction cases).
3. Two models with two sets of prompts make the same judgment, which makes inconsistent results hard to debug.

## Design

### When the pre-check is on

The pre-check runs only when all of these hold:

1. The decision route and the main loop use different profiles (the existing `SameProfile` check in `channel_bootstrap.go`). With the same profile, an extra call is not faster, so behavior stays as it is.
2. The decision client supports Evaluate.

Otherwise behavior stays exactly as it is today, main-loop prompt included.

The channel does not need native reactions. Channels without them send the chosen emoji as a normal message instead; see "Delivering the emoji".

### Two checks

| Check | Used for | Questions |
| --- | --- | --- |
| Full group check (exists) | Group messages without an explicit mention | confidence, interject, impulse, reply, emoji |
| Lightweight check (new) | Private chats; group messages with an explicit mention or a reply to the bot | `reply` and `emoji` only |

Both ask how to reply in two questions: `reply` chooses between `text` and `emoji`, and `emoji` chooses among the channel's emojis (see "Delivering the emoji"), at most 255. They are separate because, asked as one choice, the many emoji options outweigh the single text option and a judging model picks an emoji almost every time. The lightweight check doesn't ask "is this addressed to me?", because a private chat or an explicit mention already answers that.

### New flow

"precheck on" means all the conditions above hold.

```
                          inbound message
                                |
               +----------------+-----------------+
               |                                  |
           group chat                        private chat
               |                                  |
      explicit mention / reply?                   |
         |               |                        |
         no             yes                       |
         |               |                        |
  mode smart/talkative?  +-----------+------------+
     |         |                     |
     no       yes                    v
     |         |               precheck on? ------- no -------------+
   ignore      v                     |                              |
   [decision: full group check]     yes                             |
               |                     v                              |
        +------+------+     [decision: lightweight check]           |
        |             |      ("response" question only)             |
     reaction        text            |                              |
        |             |      +-------+--------+---------+           |
   react, done        |      |                |         |           |
                      |   reaction           text     error ------->+
                      |      |                |                     |
                      |   react ok? -- no ----|-------------------->+
                      |      |                |                     |
                      |     yes               |                     |
                      |      |                |                     |
                      |   done, skip          |                     |
                      |   main loop           |                     |
                      |                       |                     |
               precheck on? -- no ------------|-------------------->+
                      |                       |                     |
                     yes                      |                     |
                      |                       |                     |
                      +-----------+-----------+                     |
                                  |                                 |
                                  v                                 v
                 [main loop: prompt WITHOUT          [main loop: prompt WITH
                  lightweight rules]                  lightweight rules]
                  final.is_lightweight = false        (current behavior)
                  always publish text
```

Notes:

- When the full group check chooses `text` and the pre-check is on, the lightweight question is already answered. The message goes straight to the main loop without the lightweight rules. There is no second check.
- When the pre-check is off (for example, the decision route and the main loop share a profile), the full group check runs as today, and `text` leads to today's main loop.
- "react" in the diagram means delivering the emoji: a native reaction where the channel has one, otherwise an emoji message (see "Delivering the emoji").
- If the lightweight check fails, or picks an emoji that then fails to send, the message falls back to the main loop with the lightweight rules. See "Failure handling".

### Delivering the emoji

Once a check picks an emoji, the runtime delivers it in one of two ways:

| Channel | Delivery | Emoji options |
| --- | --- | --- |
| Telegram, Slack, Discord, Lark | Native reaction on the triggering message, as today | The channel's allowed reactions (Telegram standard set, Slack names, Discord and Lark types) |
| LINE, WeChat, WhatsApp, Mixin, Console | A normal message whose whole content is the emoji | A shared default set of common Unicode emoji (for example the Telegram standard set from `tools/telegram.StandardReactionEmojis`), kept short so the question stays cheap |

For the message fallback:

- In a group, send it as a reply or quote to the triggering message where the channel supports that, so it is clear what it answers. In a private chat, send it as a plain message.
- Record it in the conversation history as the assistant's reply, like any text reply, so later turns see that the bot already answered. A native reaction is recorded the way it is today.
- In the Console, the emoji is the task's final output: the run completes with that output and no main-loop request. The Console does not go through the channel bootstrap, so it needs its own hook where a chat message is turned into a task (`cmd/mistermorph/consolecmd`).
- Sending is a normal message send, so it follows the channel's usual delivery and failure handling.

The full group check on LINE does not pass a reaction tool today. With this fallback it can deliver its emoji choice as a message too, instead of only offering `text`.

### Reorganizing the main-loop prompt

The main loop needs to know "the lightweight check is done, and the answer is text". Add a field to `agent.PromptSpec`, for example `LightweightDecided bool`, which the channel runtime sets when it starts the main loop. When it is true:

| Where | Change |
| --- | --- |
| `agent/prompts/system.md`, final JSON | Remove the `reaction` and `is_lightweight` fields |
| `agent/prompts/system.md`, Response Rules | Remove the "lightweight acknowledgement" definition and the "IF is_lightweight THEN message_react" rule |
| `block_telegram.md`, `block_slack.md`, `block_discord.md`, `block_lark.md` | Remove the "react instead of replying" and reaction-only rules; keep notes on reaction argument formats |
| Final parsing | Force `IsLightweight = false`; an empty output is an invalid final, not a lightweight one |

The `message_react` tool stays, for when the user explicitly asks for a reaction ("give that message a thumbs up"). The prompt just no longer steers the model to react instead of replying.

### Prompt caching

The system prompt gains a second version: with and without the lightweight rules. Whether the pre-check is on depends only on config and channel, so the version is stable within a conversation and prefix caching keeps working. Keep anything else dynamic out of this switch.

### Failure handling

A broken decision profile must never stop the bot from replying.

| Case | Handling |
| --- | --- |
| Decision client doesn't support Evaluate | Treat the pre-check as off; use the current flow |
| Timeout, network error, invalid answer | Log it; use the main loop with the lightweight rules (current behavior) |
| Emoji chosen but sending it (reaction or message) fails | Log it; use the main loop with the lightweight rules |
| Emoji chosen and sent | Done; the main loop does not start |

The timeout is the decision profile's `request_timeout`, as in the group check. Any `fallback_profiles` on the route still apply.

## Costs and trade-offs

### Delay from the extra call

Most private messages are questions or requests, so the check will usually answer `text`. Those messages wait for one extra quick call before the main loop starts. The gain only shows on messages like "OK" or "thanks".

Possible mitigations, not in the first version:

- **Start both at once:** run the check and the main loop together, and cancel the main loop if the check picks a reaction. No extra wait, but the cancelled main loop is still paid for. It also conflicts with removing the lightweight rules, because the main-loop prompt has to be fixed before the check returns.
- **Skip by rule:** go straight to the main loop for long messages or messages with attachments. Such rules misjudge easily.

The first version runs the check first, then the main loop. After release, compare time to first reply and the reaction rate for private chats in the usage stats before deciding on any mitigation.

### Judgment quality

A small model may judge a real question as emoji-only, which is worse than replying with an unneeded sentence. The `reply` question's instructions must say clearly that questions, requests, and anything asking for information must get `text`. Move the existing "a question or request must not be reaction-only" rule from the channel prompt blocks into those instructions.

## Scope of changes

| Module | Change |
| --- | --- |
| `internal/grouptrigger` | Add the lightweight check that asks only `reply` and `emoji`; make the full check's result say when it already chose `text` |
| `internal/channelruntime/core/channel_bootstrap.go` | Expose whether the pre-check is on (different profiles and Evaluate supported) |
| `internal/grouptrigger` | Add a shared default emoji set for channels without native reactions |
| All channel runtimes (Telegram, Slack, Discord, Lark, LINE, WeChat, WhatsApp, Mixin) | Run the lightweight check on private chats and explicit mentions; deliver the emoji as a reaction or a message; pass the result to the main loop |
| Console (`cmd/mistermorph/consolecmd`) | Run the lightweight check before starting a chat task; complete the task with the emoji as output when chosen |
| `agent` | Add `PromptSpec.LightweightDecided`; render `system.md` per the flag; force non-lightweight finals |
| `internal/promptprofile/prompts/block_*.md` | Render the lightweight rules per the flag |
| Lark group check | Pass the reaction tool so the group check can react natively |
| LINE group check | Deliver the chosen emoji as a message |
| Docs | Update the lightweight sections of `docs/telegram.md` and `docs/prompt.md` |

## Implementation notes (v1)

What was built, and where it differs from or adds to the design above.

Shared pieces:

- `grouptrigger.DecideLightweight` is the model call: it asks only `reply` and `emoji`, with its own prompt (`internal/grouptrigger/prompts/lightweight_system.md`).
- `core.RunLightweightPrecheck` runs it on a channel bundle, delivers the emoji, and applies the fallback rules. It returns `PrecheckSkipped`, `PrecheckText` or `PrecheckHandled` (with the emoji). It runs only when `ChannelRuntimeBundle.LightweightPrecheck` is set (decision and main-loop bootstrap routes are different profiles), uses the decision profile's `request_timeout` (30s when unset), and offers `grouptrigger.DefaultLightweightEmojis` when the channel gives no emoji list.
- `core.LightweightPrecheckApplies` skips messages with attachments, commands (text starting with `/`) and empty text.
- `taskruntime.RunRequest.LightweightDecided` sets `agent.PromptSpec.LightweightDecided` before any prompt augment runs, so channel blocks read the flag from the spec; no `Append*RuntimeBlocks` signature changed.
- The parser ignores `is_lightweight` on a decided run unless the run has already reacted (an explicitly requested reaction may still end the run without text).
- The group check takes `DecideOptions.React`, a function that delivers the emoji, instead of a reaction tool. Channels with reactions wrap their tool with `grouptrigger.ReactWith`; LINE passes a function that sends the emoji as a message.

Where each channel runs the check:

| Channel | Where | Delivery | Notes |
| --- | --- | --- | --- |
| Telegram | Update handler, after steering, before publishing to the bus | Native reaction (standard set) | Result carried on the bus in `MessageExtensions.LightweightDecided` |
| Slack | Bus consumer (`enqueueInbound`), after steering | Native reaction when the emoji catalog loaded, otherwise an emoji message | Group-check result carried on the bus |
| Discord | Bus consumer, after steering | Native reaction | Skipped for slash commands, whose placeholder needs a text reply |
| Lark | Bus consumer, after steering | Native reaction (Lark emoji types) | The group check now also gets the reaction tool |
| LINE | Bus consumer, after steering | Emoji message | The group check now offers emojis, sent as a message |
| Mixin | Bus consumer, after steering | Emoji message | No group trigger; every message is checked |
| WeChat, WhatsApp | Bus consumer, after steering | Emoji message | Files and voice notes are described in the message text, which the check reads |
| Console | Task worker (`runTask`), before the main loop | Emoji as the task output | Only for chat typed in the Console (`ui` trigger), without file references, wake signals, `/think`, `/init`/`/update` or an approval to resume; the decision client is created per check and compared with the task's own route |

A handled message is recorded in history as the inbound message plus the reply: a reaction note where the channel reacted, otherwise the emoji as the bot's message.

Limits:

- The "different profile" check compares the decision route with the bootstrap main route (in the Console, with the task's route). A conversation switched to another profile is not re-checked.
- No run against a real model yet; behavior is covered by unit tests with stub evaluators.

## Acceptance

- When the decision route and the main loop share a profile, every channel's behavior and prompts are exactly as today.
- With the pre-check on, "thanks" in a private chat gets only a reaction, and the main loop does not run (no main-loop request in the usage stats).
- On a channel without native reactions (for example WeChat or the Console), "thanks" gets a single emoji message, recorded in history as the assistant's reply, and the main loop does not run.
- With the pre-check on, a question in a private chat gets a text reply, the main-loop system prompt has no lightweight rules, and the final is never treated as lightweight.
- After the full group check chooses `text`, the main loop adds no reaction, so none of the double-reaction cases in `docs/telegram.md` occur.
- When the decision profile is unavailable, every message still gets a reply as it does today.
- Tests cover: the on/off conditions, both prompt versions, native reaction vs. emoji-message delivery, fallback on check failure, and fallback when sending the emoji fails.
