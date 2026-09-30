---
date: 2026-09-30
title: Plan steps closed by the agent, each sent to the user as a message
status: implemented-v1
---

# Plan steps closed by the agent, each sent to the user as a message

## Goal

When an agent works through a plan, it should tell the user what each step found or produced as the step finishes,
in a message of its own, the way a person reports progress: several messages for one task, then the final answer.
For that, a step has to be marked done by the agent, when its goal is met, with a one-line result.

## Today

- **Steps advance on any tool call.** After every successful tool call other than `plan_create`, the engine marks
  the current step completed and starts the next (`agent/engine_loop.go`, `AdvancePlanOnSuccess`). What the call did
  does not matter, so steps often complete early: in a June console task, the step "read the skill instructions" was
  marked completed while the next step's read of `review_zh.md` was still running. A final answer completes every
  step (`CompleteAllPlanSteps`).
- **Updates carry titles only.** `PlanStepUpdate` has the completed and started step's index and title, and a reason
  (`plan_created`, `tool_success`).
- **Channels:**
  - Console: streams the plan's steps and statuses to the task view (`buildConsolePlanProgress`).
  - Slack: edits one working message into a checklist (`buildSlackPlanProgressBlocks`).
  - Telegram: keeps one progress message per task and edits it (`sendPlanProgress`): an expandable blockquote with a
    line for each step as it starts, newest first, with an emoji for the tool it names
    (`renderTelegramPlanProgressExpandable`).
  - TUI (`chatcmd`): shows updates in its activity view; `run`: prints them.

So progress is visible, but it can be wrong, and it never says what came out of a step.

## Design

### 1. The agent closes steps, with no new tool

A model can write text alongside its tool calls. Today the engine keeps that text in the conversation and nothing
else reads it. While a plan runs, it becomes the step's result:

- **The rule.** When a response with tool calls also has text, and the in-progress step has had at least one tool
  call, the engine marks that step completed with the text as its note, starts the next pending step, and reports a
  `PlanStepUpdate` with reason `agent`. The tool calls then run as usual, as the next step's first actions.
- **So closing a step costs nothing extra:** no tool, no additional model round trip, no change to any provider's
  response format.
- **Text in the first response of a step does not count** (the step has had no tool call yet). This keeps a model
  that announces what it is about to do ("Let me read the file") from closing steps it has not worked on.
- `AdvancePlanOnSuccess` no longer runs after tool calls. A final answer still completes every step, as now, so a
  plan never stays open after the task ends.

For example, with a plan of read, draft, check:

```text
response 1: tool read_file(review_zh.md)                       → step 1 in progress
response 2: "review_zh.md has 6 sections and 2 tables."        → step 1 completed with that note
            tool write_file(review_zh.html)                    → step 2's first action
response 3: "Wrote review_zh.html, 6 slides."                  → step 2 completed
            tool bash(ls -l review_zh.html)
response 4: final answer                                       → step 3 completed
```

### 2. The note is a message

- `PlanStep` gains `Note string` (`json:"note,omitempty"`); `PlanStepUpdate` gains `Note`.
- The note is the text, trimmed. It is a message, not a label, so it is not cut to a fixed length, though the prompt
  asks for one or two sentences.
- It goes through the output guard like any reply (`guardOutputValue`): redacted or blocked the same way.
- Only text that closes a step is sent. Text the engine ignores (a step's first response) stays silent, and so does
  text with tool calls in a task without a plan, as today.
- The plan guidance prompt (`prompts/block_plan_create.md`) says: when a step is finished, tell the user what it
  produced (a count, a file, a finding, a decision) in one or two sentences, in the task's language, together with
  the next step's tool calls; do not restate the step; otherwise call tools without text. The final answer should not
  repeat what the step messages already said.

### 3. Each channel sends it

A step message is delivered like a reply, before the final answer, in order. The progress view keeps its ticks without
the note, since the note is now a message of its own.

| Channel | Step message | Progress view |
|---|---|---|
| Console | A new assistant bubble in the topic, before the task's reply. The notes live in the task's plan (`consolePlanStep.note`), which is already streamed and stored, so the messages appear as the plan streams in: each is a `.chat-history-copy` in the reply's `.chat-history-stack`, after the plan card and before the reply (`planStepMessages`), and the prompt history includes them before the reply (`chathistory.TaskStepMessages`). | The plan area, unchanged. |
| Telegram, private and group chats | Sent as a message, like the final answer (in a group, as a reply in the same thread as the final answer). | The expandable blockquote, unchanged. |
| TUI (`chatcmd`) | Printed as assistant text in the conversation, like the final answer; in remote mode, when a stream frame brings a new note. The model's history keeps one assistant message per turn, the notes followed by the reply. | The activity view, unchanged. |
| Slack | Not sent: Slack stays as it is today. | The working message's checklist, unchanged. |
| `run` | Not sent; `run` prints the final answer only, as today. | Unchanged. |

Telegram's chat history records step messages as outbound items before the reply, so later turns see them like any
reply.

Slack's working-message checklist is unchanged, but its ticks now follow the agent's reports instead of every tool
call, like every channel's progress view.

In tool emulation mode (`tools_emulation_mode`), uniai returns emulated tool calls with no text, so steps close only
at the final answer and no step messages are sent.

## What does not change

- `plan_create`: how plans are made, `max_steps`, and the plan's shape (the note is optional).
- Tasks without a plan.
- How the final answer is delivered.
- Slack and `run`.

## Tests

- Engine: text with tool calls completes the in-progress step with that note and starts the next; text in a step's
  first response does not; tool calls without text no longer advance steps; a final answer completes the rest; the
  note is trimmed and guarded; with no plan, text with tool calls changes nothing.
- Prompt: the plan guidance describes the one-line result.
- Console: step messages stream as bubbles, are stored on the task in order, and appear in the topic history and the
  prompt history before the final answer.
- Telegram: in private and group chats each step message is sent once, in order, before the final answer, and is in
  chat history.
- TUI: step messages print in order before the final answer.
- Slack and `run`: nothing changes.

## Open questions

1. **Models that chat before every call.** Some models write a line with every tool call ("Now I'll check the
   output"). After a step's first call, each such line would close a step and now also reach the user as a message.
   The prompt is the main guard. If a model keeps doing it, options are: close a step only when the line reads as a result
   (not a plan for what comes next), which needs a judgement the engine cannot make cheaply; or accept it for those
   models.
2. **A model that never writes the line.** With auto-advance gone, the first step stays in progress until the final
   answer. Options: accept it (the final answer completes the plan); or after several tool calls on one step, add a
   one-time reminder to the conversation.
3. **Text without a plan.** A long task without a plan could also send its text alongside tool calls as messages. Not
   in this change; it would need its own rule for what counts.
