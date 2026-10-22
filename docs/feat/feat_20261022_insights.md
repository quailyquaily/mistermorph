---
date: 2026-10-22
title: Insights, messages the agent sends before its final answer
status: implemented-v1
---

# Insights, messages the agent sends before its final answer

## Goal

A person working on a request often sends more than one message: "found it, the timeout is 0", then later the
answer. The agent should be able to do the same in a task without a plan: when it learns something worth saying
before it finishes, it says it, in a message of its own, and keeps working.

## Today

- With a plan, this already exists: text a model writes with its tool calls closes the plan step and is sent as the
  step's message (`feat_20260930_plan_step_feedback.md`).
- Without a plan, that text stays in the conversation and nothing else reads it. The user hears only the final answer,
  plus runtime notices (context compaction, coder progress) that the model does not write.
- That doc left this as an open question ("Text without a plan").

## Design

### 1. The engine: text with tool calls becomes an insight

No new tool and no extra model round trip. In a response with tool calls, the engine treats the text as an insight
when all of these hold:

- insights are on for the run (`agent.WithInsights(limit)`);
- the run has no plan (with a plan, the text closes a step, as today);
- it is the top-level run (`SubtaskDepthFromContext(ctx) == 0`); subagents report to the agent that started them,
  not to the person;
- the run has made at least one tool call; text before that is usually an announcement ("Let me look at the
  logs"), so it stays silent, like a plan step's first response;
- fewer than `limit` insights have been sent.

The text is cleaned the same way as a plan step note (`planStepNoteFromText`) and goes through the output guard
(`guardOutputValue`). Models that answer in the JSON response format sometimes wrap the note in it: a plan's
reasoning, a final's output, or a type of their own with a text `output` (`{"type":"progress","output":…}`, seen
from `gpt-6-astra`) is the message. Other JSON is not sent, and the engine logs `insight_skipped` with
`reason: not_a_message` and the JSON's top-level keys (not its values), so a new shape shows up in the logs before
anyone adds it. Then the engine:

- appends it to `Context.Insights` (kept in the run-state snapshot, so it survives an approval pause);
- emits an `EventKindInsight` event (`"insight"`) with the text in `Text`.

The text stays in the conversation as part of the assistant message, so later steps of the run know it was said.
Past the limit, the text is still in the conversation but is not sent.

### 2. The runtime: a sink delivers it

The engine does not send anything. Delivery goes through the event sink chain, like the coder progress notice:

```go
runCtx = taskruntime.WithInsightNotification(runCtx, logger, taskruntime.InsightLimitFor(isGroup),
	func(ctx context.Context, seq int, text string) error {
		return publish(ctx, text, fmt.Sprintf("<channel>:insight:%s:%d", taskID, seq))
	})
```

`WithInsightNotification` does two things:

- installs a sink that sends each insight event through `notify`, synchronously, so the message goes out before the
  run continues and before the final answer;
- puts the limit on the context. `taskruntime` reads it in `prepareRun` and, for a top-level run (not a subtask, not
  `DisableRuntimeTools`), adds `agent.WithInsights(limit)` and the insight prompt block. A run whose context has no
  limit (`run`, TUI, subtasks) gets neither, so it behaves as before.

Limits (`taskruntime.InsightLimit*`): 20 per task, 8 in a group chat, since each message notifies people.

### 3. The prompt

`internal/promptprofile/prompts/block_insight.md` (`AppendInsightBlock`, skipped for final-only responses) tells the
model:

- without a plan, it can write one or two sentences as plain text with its next tool calls, and they are sent at once;
- for something worth a message: a finding that changes the picture, a change of direction, a partial result the
  user can use now, an assumption the user may want to correct;
- in a task of several steps, a key finding once it is confirmed rather than at the end (with an example: who owns a
  company being researched);
- no narration of routine steps; text before the first tool call is not sent;
- the limit for the task;
- the final answer still gives the conclusion, without repeating the insights.

### 4. The reminder

A model can stay silent through a long task only because it did not think of insights: in a test researching a
company's officers, shareholders and funding, `gpt-6-astra` made 10 responses with tool calls and wrote no text in
any of them, though one had confirmed who owned the company. So when a run with insights on (no plan, not a subtask,
under the limit) has made 5 responses with tool calls since it started or last sent an insight
(`insightReminderAfter`), the engine adds a user message to the conversation, once per run, before the next model
call (`remindOfInsights`, where queued steers are applied):

```text
[[ Runtime Note ]]
You have been working for several steps without telling the user anything. If you have confirmed something they
would want to know now, write one or two sentences as plain text with your next tool calls; they are sent right
away. If not, carry on without text.
```

The log has `insight_reminder` with the number of silent responses. The count is not kept across an approval pause.

### 5. History

Each channel adds the sent insights (`Context.Insights`) to its chat history before the plan step notes and the
reply, so later turns see them like any reply.

## Channels

| Channel | Sent | Limit | In chat history |
|---|---|---|---|
| Telegram | `telegram:insight:<task>:<n>`, in the job's thread | 20, group 8 | yes |
| Slack | in the job's thread | 20, group 8 | yes |
| Discord | as a reply to the job's message | 20, group 8 | yes |
| Lark | as a reply to the job's message | 20, group 8 | yes |
| LINE | to the chat | 20, group 8 | yes |
| Mixin | to the conversation | 20, group 8 | yes |
| Account DM | to the peer | 20 | yes |
| Console | a bubble in the topic before the reply (see below) | 20 | yes |
| TUI (`chatcmd`), `run` | not on | — | — |

### Console

- **Live:** each insight publishes a stream frame with `insights`, the full list so far
  (`consoleStreamHub.PublishInsights`); the hub keeps it in the frame a reconnecting client receives.
- **Stored:** the task result gets `insights` (`buildConsoleTaskResult`), so a reloaded topic shows them.
- **Shown:** each is a `.chat-history-step` bubble in the reply's stack, before the plan step messages and the reply
  (`insightMessages` in `chat-task-history.js`, used by `ChatHistoryItem`).
- **Prompt history:** `chathistory.TaskStepMessages` returns the insights, then the plan step notes, before the reply.

## What does not change

- `plan_create` and plan step messages. A run with a plan sends step notes, not insights.
- Runs without the context limit: no prompt block, no events.
- The final answer and how it is delivered.

## Tests

- Engine (`agent/engine_insight_test.go`): text after the first tool call is sent and recorded; text before it is
  not; past the limit nothing is sent; nothing without `WithInsights`; with a plan the text is a step note, not an
  insight; subtasks do not send; insights survive the run-state snapshot. The reminder comes once, after five silent
  responses; an insight restarts the count; no reminder without insights.
- Runtime (`taskruntime/insight_notification_test.go`): insights go out in order with their sequence numbers, other
  events pass through, empty text is skipped, a send failure is logged and does not stop the run; no notify or no
  limit leaves insights off.
- Prompt: the block states the limit; nothing without a limit or for final-only responses.
- Discord: the turn history puts insights before the reply.
- Console: the stream hub keeps insights in the reconnect frame; the prompt history puts insights before plan step
  notes; the frontend reads them from the task result and turns them into messages (`chat-task-history.test.mjs`).

## Open questions

1. **TUI.** The TUI would print insights like step messages. Left for a follow-up.
2. **Models that narrate.** Some models write a line with every tool call. The rule "not before the first tool call"
   only catches the first one; the prompt and the limit are the other guards. If a model keeps narrating, options are
   a stricter prompt for that model (`AppendModelPromptPatches`) or turning insights off for it.
3. **Other JSON shapes.** Only a text `output` is taken from JSON a model did not have to write. Keys such as `text`,
   `message` or `content` also appear in data, so they are added only when `insight_skipped` shows a model using
   them. The prompt names the JSON object as what not to write.
4. **The limit.** The prompt states it, but text past it is dropped without telling the model, so a model that
   ignores the limit may believe later text was seen. In a test reviewing 6 commits, `gpt-6-astra` kept to it: four
   notes, the fourth saying the rest would be in the final summary. The engine logs `insight_limit_reached` so this can
   be measured.
5. **Models that write no text with tool calls**, including tool emulation mode, send no insights. That is acceptable.
   The reminder (Design 4) is for models that can but do not think of it.
6. **Long silent stretches.** A model may say nothing for a long time. A runtime "still working" notice after a quiet
   period would cover that, as the coder progress notice does for `coder`.
7. **Plans.** Once insights have been used for a while, compare tasks with and without `plan_create` to decide
   whether plan step messages are still needed.
