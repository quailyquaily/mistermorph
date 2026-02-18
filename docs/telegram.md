# Telegram Runtime: Trigger and Reaction Flow

This document explains how Telegram runtime decides:

1. whether a group message should start an agent run
2. whether to send a text reply or only react with emoji

Code references are under `internal/channelruntime/telegram/*` and `tools/telegram/*`.

## 1) Two Separate Decisions

Telegram runtime uses two independent decisions:

1. Trigger decision (enter agent run or ignore)
2. Output modality decision (text reply vs emoji reaction)

They are not the same check.

## 2) Trigger Decision (Group Message)

Entry point:
- `internal/channelruntime/telegram/runtime.go`
- `internal/channelruntime/telegram/trigger.go`
- `internal/grouptrigger/decision.go`

### 2.1 Quick rules

- `strict`: only explicit mention/reply paths can trigger.
- `smart`: trigger when addressing LLM returns `addressed=true` and `confidence >= threshold`.
- `talkative`: trigger when addressing LLM returns `wanna_interject=true` and `interject > threshold`.

### 2.2 Explicit mention/reply shortcuts

Before LLM addressing, runtime checks explicit signals such as:
- reply to bot message
- mention entity / `@bot_username` mention in body

If explicit match succeeds, trigger is accepted directly.

### 2.3 Important boundary

Trigger layer only decides whether to run the agent.
It does not decide text vs reaction modality.

### 2.4 Trigger output fields

`grouptrigger.Decide(...)` returns `Decision`, and `Decision.Addressing` includes:

- `addressed`
- `confidence`
- `wanna_interject`
- `interject`
- `impulse`
- `is_lightweight`
- `reason`

So yes, trigger output also carries `is_lightweight` (from addressing LLM output).
But in current runtime design, this field is not the final publish switch; final text/no-text is still decided by `final.is_lightweight` from generation output.

## 3) Reaction Decision (Generation Layer)

Entry point:
- `internal/channelruntime/telegram/runtime_task.go`
- `tools/telegram/react_tool.go`
- `internal/channelruntime/telegram/runtime.go`

### 3.1 Registration gate (tool availability)

`telegram_react` is registered only when all conditions hold:

- Telegram API is available (`api != nil`)
- inbound `message_id` is non-zero

If not registered, reaction cannot be applied in this run.

### 3.2 Execution gate (tool call must succeed)

Even when the tool is available, a reaction is considered successful only when `telegram_react` executes without error.
`react_tool` validates:

- target `chat_id` / `message_id` (explicit or defaulted from current inbound message)
- allowlist authorization (`allowedIDs`) when configured
- emoji is in Telegram standard reaction list
- Telegram API call (`SetEmojiReaction`) succeeds

Only then does the tool persist `lastReaction`.

### 3.3 Runtime confirmation and recording

After `agent.Engine.Run`, runtime checks `reactTool.LastReaction()`:

- `nil`: no reaction applied
- non-`nil`: runtime logs `telegram_reaction_applied` and appends an outbound reaction history item

So runtime state is based on actual tool success, not on intent text.

### 3.4 Boundary with text publishing

Reaction and text are related but not the same switch:

- text publishing is controlled by `final.is_lightweight` (`shouldPublishTelegramText(final) == !final.IsLightweight`)
- reaction applied is controlled by `reactTool.LastReaction() != nil`
- `dec.Addressing.is_lightweight` from `grouptrigger.Decide` is trigger metadata only; it does not directly publish/suppress text

## 4) Text Decision

### 4.1 `is_lightweight` semantics

`is_lightweight` is now a runtime switch for Telegram text publishing:

- `true` -> no text outbound
- `false` -> text outbound

## 5) Runtime Signals

Useful logs:

- group ignored:
  - `telegram_group_ignored`
- group triggered:
  - `telegram_group_trigger`
- reaction applied:
  - `telegram_reaction_applied`

`telegram_reaction_applied` is an info log, not an error.

## 6) ASCII Flow

```text
Telegram group inbound
  -> explicit mention/reply check
  -> grouptrigger.Decide(mode=strict|smart|talkative)
     -> output dec.Addressing.is_lightweight (trigger metadata)
     -> not triggered: ignore
     -> triggered: runTelegramTask
          -> agent.Engine.Run
             -> output final.is_lightweight
             -> optional tool call: telegram_react
          -> if is_lightweight=false: 
             -> publish normal text reply
          -> if is_lightweight=true:
             -> no text outbound
             -> reaction present => record reacted history
```
