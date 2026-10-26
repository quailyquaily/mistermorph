---
date: 2026-10-23
title: ask_user, questions the agent asks the user mid-task
status: draft
---

# ask_user

## 1) Problem

A run sometimes hits a decision only the user can make: which of two accounts to use, whether to
overwrite a file, what a vague request meant. Today the model can only end its turn with a question
in the final answer. That loses the run's working state, offers no choices to click, and the reply
starts a new turn.

Approvals (`docs/feat/feat_20260622_human_approval_flow.md`) do not cover this: an approval is a
yes or no on one fixed tool call, and that doc keeps "the model needs information" out of scope.

## 2) Behavior

The model calls `ask_user` with one question and up to four choices. The tool sends the question to
the user and waits, inside the run, for the answer. The answer comes back as the tool result and the
loop goes on with all its state.

- **Console:** the question shows as a card in the chat, like Claude Code's: a numbered button per
  choice (the number keys pick one too) and a field for a typed answer.
- **Telegram and Slack:** the question is a message with one button per choice. A typed message
  also answers it.
- **Answered:** the card or message is updated to show the answer and loses its buttons.
- **No answer:** after `UserQuestionTimeout` (10 minutes), or sooner when the task deadline is
  closer, the tool returns "no answer". The model goes on with its best judgment and says what it
  assumed. The card or message shows that the question expired.
- **`/stop`** while a question is open stops the task as usual.

While a question is open, the next message the user types in the conversation is the answer, not a
steer. Messages after that steer the run as before.

## 3) Where the tool is offered

Only where one person is there to answer, through a surface with buttons:

| Surface | ask_user |
| --- | --- |
| Console chat, a task the user sent (trigger ref `web/console/chat`) | yes |
| `mistermorph chat`, local or attached with `--runtime-url` (trigger ref `cli/chat`) | yes |
| Console heartbeat, cron, TODO and other background tasks | no |
| Telegram private chat | yes |
| Slack DM | yes |
| Telegram and Slack groups, channels and threads with several people | no |
| Discord, Lark, LINE, Mixin, WeChat, WhatsApp, account DMs, agent links | no |
| Subtasks (`spawn`, `coder`) | no; they report to the agent that started them |
| codemode scripts | no (`CodeModeExcluded`) |

A runtime turns the tool on for a task with `taskruntime.WithUserQuestions(ctx, ask)`; without it
the tool is not registered. Console tells its chat tasks apart by their trigger: the chat sends
`{source: "ui", event: "chat_submit", ref: "web/console/chat"}`, chat attached with `--runtime-url`
sends `ref: "cli/chat"`, while other submitters (the Skills page, older pages) get the default ref
`web/console`. Local chat sets the tool on its own turns. In chat the question is a card in the TUI:
number keys pick a choice, or type an answer; Esc closes it without one (locally the tool gets "the
user closed the question"; attached to a runtime, the runtime waits until its timeout).

## 4) Design

Waiting happens inside the run. Pausing and resuming the run, like approvals, is not done in this
version.

### 4.1 Tool

`ask_user` (`internal/channelruntime/taskruntime/ask_user.go`):

```json
{
  "question": "Which account should the invoice go to?",
  "options": [
    {"label": "Personal", "description": "lyric@example.com"},
    {"label": "Company"}
  ]
}
```

- `question` is required. `options` is optional, with 2 to 4 choices when present. A typed answer is
  always accepted, as Claude Code's "Other" is.
- Result: `The user chose: <label>`, `The user answered: <text>`, or the no-answer text.
- One question per call. Calls in one response run in order, so two questions are asked one after
  the other.

### 4.2 Run control

The answer arrives through the run's `runtimecontrol` lease:

- `RunLease.OpenQuestion(questionID, labels)` opens the question on the active run before it is shown; `Wait` waits for the answer.
- `RunControl.Steer` gives the text to the open question, when there is one, instead of queueing it
  (`SteerResult.Answered`).
- `RunControl.Choose(runtime, questionID, option)` answers from a button and returns the choice's
  label; `RunControl.AnswerText(runtime, questionID, text)` answers with typed text. Both find the
  run by the question ID, which is random, so a stale button does nothing.
- `taskruntime.LeaseUserQuestions(lease, logger, show)` builds a runtime's `AskUserFunc` from these:
  `show` sends the question and returns a settle func that updates it once it closes.

### 4.3 Runtimes

Each runtime's `AskUserFunc` sends the question, waits on the lease, and then updates the message:

- **Console:** the stream frame carries `questions`, every question of the task in order, each with
  `id`, `text`, `options`, `status` (`open`, `answered`, `expired`), `answer` and `option` (-1 for
  a typed answer). The task result keeps them as `result.questions`. The card posts
  `POST /tasks/{id}/answer` with `{question_id, option}` or `{question_id, text}`; the response says
  whether the question was still open. A message sent from the composer while a question is open
  also answers it, through the steer path.
- **Telegram:** `sendMessage` with an inline keyboard. Callback data `aq:<question id>:<index>`.
  When answered or expired, the message is edited, which removes the keyboard.
- **Slack:** `chat.postMessage` with an actions block; action IDs `morph_ask_<index>`, value
  `aq:<question id>:<index>`. When answered or expired, `chat.update` replaces the blocks.

### 4.4 Prompt

The system prompt's response rule ("do not call tools to respond to users") makes `ask_user` its one
exception. Without that, a model asked to "ask me first" ended the task with the question as its
final answer, even with the tool offered.

When the run has `ask_user`, `promptprofile.AppendAskUserBlock` adds an "Asking the User" block
(`internal/promptprofile/prompts/block_ask_user.md`). It and the tool description ask the model to:

- call `ask_user` instead of ending its turn with a question, since a question in a final answer
  ends the task;
- ask only for a decision or fact it cannot find or reasonably decide itself, and not for
  permission to do what was asked;
- offer 2 to 4 short, distinct choices when the answer is one of a few, one question at a time.

## 5) Limits

- An open question is lost if the process restarts, like any running task.
- The wait counts against the task deadline (`timeout`, 1 hour by default).
- One open question per run.
- A typed answer through the Console composer also leaves the usual steer message in the chat.
