# Prompt Inventory

This document tracks where prompts are defined today, how they are composed at runtime, and how `mister_morph_meta` is injected.

## Main System Prompt Composition

### 1) Base spec and rendering

- `DefaultPromptSpec()` provides the base `PromptSpec`.
- `BuildSystemPrompt(...)` renders the final system prompt.
- `PromptBlock` now only contains `Content`; there is no `Title` field.
- Block labels should be written directly in block template content (for example `[[ Telegram Policies ]]`).

### 2) Skill metadata

- `PromptSpecWithSkills(...)` discovers/loads skill frontmatter and appends `spec.Skills`.
- Skills are rendered into the system prompt under `## Available Skills`.

### 3) Persona identity

- `ApplyPersonaIdentity(...)` loads local persona docs and may replace `spec.Identity`.
- Canonical files are `persona/identity.yaml` and `persona/soul.md`.
- `persona/avatar.webp` is only a UI asset and is not injected into prompts.

### 4) Runtime prompt blocks

Runtime block appenders:

- `AppendPlanCreateGuidanceBlock(...)`
- `AppendTodoWorkflowBlock(...)`
- `AppendTelegramRuntimeBlocks(...)`
- `AppendSlackRuntimeBlocks(...)`
- `AppendLineRuntimeBlocks(...)`
- `AppendLarkRuntimeBlocks(...)`

These blocks are applied in the major runtime task flows:

- Awareness runtime tasks in `internal/channelruntime/awareness`
- `runTelegramTask(...)`
- `runSlackTask(...)`
- `runOneTask(...)`
- CLI run path inside `runcmd.New(...)`

## Group Trigger / Addressing

### Decision behavior

- `Decide(...)` is the shared group-trigger decision function.
- If `ExplicitMatched=true`, it accepts immediately and does not call addressing LLM.
- Otherwise, in `smart` / `talkative` modes, it may call addressing LLM.

### Telegram addressing

- Trigger entry: `groupTriggerDecision(...)`
- Addressing classifier: `addressingDecisionViaLLM(...)`
- Prompt rendering: `renderTelegramAddressingPrompts(...)`
- Lightweight reaction path can use `message_react`.

### Slack addressing

- Trigger entry: `decideSlackGroupTrigger(...)`
- Addressing classifier: `slackAddressingDecisionViaLLM(...)`
- Slack addressing prompt is currently assembled inline (not a separate template file).
- Lightweight reaction path can use `message_react`.

## Template Index

Template directories only:

- Main system prompt templates: `agent/prompts/`
- Runtime block templates: `internal/promptprofile/prompts/`
- Telegram addressing templates: `internal/channelruntime/telegram/prompts/`

## Sub Prompts (Independent `llm.Request` Calls)

These are LLM calls outside the main tool-using loop.

- Plan generation: `Execute(...)` (`plan_create`)
- Telegram addressing classification: `addressingDecisionViaLLM(...)`
- Slack addressing classification: `slackAddressingDecisionViaLLM(...)`
- TODO reference resolution: `ResolveAddContent(...)`
- TODO complete semantic match: `MatchCompleteIndex(...)`
- Generic semantic dedup: `SelectDedupKeepIndices(...)`

## Request layout

A main-loop request, in the order the provider assembles the prompt. `tools` is a separate
request field, but providers place tool definitions ahead of the system text, so they sit at
the front of the cached prefix. `[*]` marks an explicit cache marker, added on a request copy
when `llm.cache_ttl` is on.

```text
   message, in prompt order                         role       changes when             cache scope
 +------------------------------------------------+
 | tools     tool definitions, by name            | (tools)    tool set changes         shared prefix:
 | system    final system prompt              [*] | system     persona, skills, blocks  reused across
 | - - - - - - - - - - - - - - - - - - - - - - -  |
 | checkpoint (if any)                            | user       a compaction             runs of one
 | (earlier conversation)  see note               | user       anthropic/bedrock only   conversation
 | history 1  {sent_at, sender, text}             | user       window slides
 | history 2  {type: final, output}               | assistant
 | ...                                            |
 | history N  (last message before meta)      [*] | user|asst  a message arrives
 +------------------------------------------------+
 | {mister_morph_meta: {run_id, now_utc, ..}}     | user       every run                new every run
 | current_message, or the raw task               | user       every run
 +------------------------------------------------+
 | assistant tool call(s)                         | assistant  each step                appended during
 | tool result(s)                                 | tool       each step                the run
 | steer / format-retry messages                  | user       as needed
 +------------------------------------------------+
   -> the model produces the next assistant turn
```

- **Two markers at most:** the end of the system prompt, and the last message before
  `mister_morph_meta` (last history message, else the checkpoint). Nothing after meta is
  marked: meta carries `run_id` and clock fields, so everything from meta on differs every run.
- **History roles:** inbound records are `user` messages in `PromptMessageItem` shape. The
  current Agent's own replies are `assistant` messages in its response shape, because models
  otherwise copy the inbound record as their next answer.
- **Stable prefix:** each history message is rendered on its own and never rewritten, so a new
  message only appends. The prefix changes when the window slides, a checkpoint is replaced,
  the system prompt changes (dynamic blocks) or the tool set changes.
- **Per provider** (`providers/uniai`):
  - `anthropic`: both markers kept.
  - `bedrock`: system marker stripped. The history marker is kept only for Claude model ARNs;
    any other ARN would reject the request.
  - `openai` / `openai_resp` on GPT-5.6: both markers kept. Other OpenAI models: markers
    stripped, and automatic prefix caching applies.
  - Other providers: markers stripped.
  - The engine sets no marker on tool definitions; they are covered by the system marker
    that follows them.
- **Leading assistant:** without a checkpoint, channel history can start with the Agent's own
  message (the window begins at a reply, or the Agent wrote first). For `anthropic` and
  `bedrock`, whose message format starts with a user turn, the provider layer inserts a fixed
  `(earlier conversation)` user turn before it. Other providers get the history unchanged.
- **Tool exchanges in a run:** OpenAI's automatic caching also reuses them from step to step.
  Explicit-marker providers cache only up to the last marker, which sits before meta.

After compaction the summarised span becomes a checkpoint. Meta stays in place and is never
summarised, so a later compaction can cross it again:

```text
 before:  system | history ... | meta | current | tool exchanges ... | recent tail
                 '---------------------- selected span -----------'
                                  meta is kept out of the summary

 after:   system | checkpoint [*] | meta | recent tail
```

## `mister_morph_meta`

### Purpose

`mister_morph_meta` is runtime metadata, not user instruction text.

### Injection path

- `Run(...)` orders messages as system, optional checkpoint, individual history messages, metadata, then the current message or task.
- Channel history uses `user` for inbound records and `assistant` for the current Agent's outbound replies. Each record is rendered independently with its own compaction boundary. Inbound records are `PromptMessageItem` JSON (`sent_at`, `sender`, `text`, …); the Agent's own replies use its response shape, `{"type": "final", "output": …}`, because models otherwise copy the inbound record shape as their next answer.
- Metadata is generated once per run. Compaction excludes it from the summary and preserves it in the request. Approval snapshots preserve its position; older snapshots retain their original layout.
- `WithRuntimeClockMeta(...)` enriches metadata with runtime clock fields.
- `buildInjectedMetaMessage(...)` wraps it into:

```json
{"mister_morph_meta": <Meta>}
```

- Oversized payloads are truncated with fallback envelope.

### Common meta producers

- CLI and channel awareness tasks use `BuildAwarenessMeta(...)`.
- Cron tasks use `BuildCronMeta(...)`.
- Heartbeat runs through the cron loop as the built-in `__heartbeat__` task and still uses heartbeat awareness meta.
- Telegram task runtime sets channel meta in `runTelegramTask(...)`.
- Slack task runtime sets channel meta in `runSlackTask(...)`.

## History cache boundary

When prompt caching is configured, the engine adds a cache marker to the last text part before runtime metadata (history or checkpoint), using a request copy. It does not write cache markers back into stored history. The system marker remains separate.

HTTP serialization tests confirm that Anthropic and OpenAI GPT-5.6 (Chat Completions and Responses) preserve both markers. OpenAI history markers use the fix in uniai v0.1.63 for [uniai #19](https://github.com/quailyquaily/uniai/issues/19). Unsupported markers are stripped so requests remain valid. Other providers retain their existing cache adaptation rules.

History window changes, checkpoint replacement, dynamic system blocks and tool changes can still shorten the common prefix. Local tests verify request structure, not actual provider cache hits or cost savings.

## Notes

- Older references under `cmd/mistermorph/telegramcmd/prompts/*` are obsolete.
- Telegram/Slack runtime policy blocks are now injected via prompt-profile block templates.
- `PromptBlock.Title` has been removed; block headers belong in template/body content.
