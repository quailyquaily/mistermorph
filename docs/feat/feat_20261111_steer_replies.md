---
date: 2026-11-11
title: Replies to steered messages
status: implemented
---

# Replies to steered messages

## 1) Problem

A message sent to a conversation while its task runs is steered into that run: the run takes it in
at its next step. The sender only got an emoji back (👌 when it was queued, 😵‍💫 when it was not).
That tells nothing about how the message was understood, answers none of its questions, and the same
👌 came back whether the message changed the work, asked something, or was unclear.

## 2) Behavior

Every message steered into a running task gets a reply written by a model, and the message still
reaches the run exactly as before: the reply does not replace or change the steering.

- **What the reply is written from:** the run's task, the conversation before it, the run's
  progress where the runtime keeps one (Console: plan and current activity), how long it has run,
  the earlier messages steered into the same run with their replies, and the message itself. For a
  typed answer to an `ask_user` question, the question too.
- **What the reply says:** for a change to the work, what will now be done differently; for a
  question, the answer from that context, or that the task will cover it; for an unclear message,
  how it was understood and one clarifying question. The prompt forbids claiming the task or the
  change is done (nothing has been done about the message yet) and forbids emoji-only or bare "OK"
  replies.
- **Model:** the model the conversation's tasks run with: in Console the steered task's model and
  LLM profile, in channels the generation's main model, in local chat the turn's route. One plain
  chat call with no tools, so writing a reply has no side effects. Its usage counts with the
  steered task's run.
- **Order and count:** replies in one conversation are written and delivered one at a time, in the
  order the messages reached the run; each message gets one reply. At most 4 replies are written at
  once per runtime; each gets 60 seconds.
- **`ask_user`:** a typed message while a question is open still answers the question; its reply
  confirms how the answer was taken.

Replies given without a model, each saying what happened to the message:

- The run is stopping, finishing (its queue is closed), or already has 32 messages waiting: the
  message was not added; send it again later.
- The model call fails, times out, or returns no words (empty, emoji or punctuation only, JSON
  without a reply): the message was added and the run still takes it in; the reply could not be
  written, and why.
- The run ended or was stopped while the reply was being written: the reply is dropped and the
  sender is told the message was not applied.
- The run ends without taking in a message whose reply was already sent: a follow-up says the
  message was not applied. A stop sends no follow-up; the stop's own reply covers it.

`/stop` keeps its emoji replies (🤔 no task, 👌 stopping); so do lightweight emoji reactions.

## 3) Where

All entry paths that steer: Console (`POST /tasks` into a topic with a running task, including
command-form text such as `/think …` that reaches the steer path), the local `mistermorph chat` TUI
(and its shared-topic record), Telegram, Slack, Discord, Lark, LINE, Mixin and the account DM
channels.

- **Console:** the steer's own task is `running` until its reply is written, then `done` with the
  reply as `final.output` and `steer_reply_status` (`replied`, `reply_failed`, `not_queued`,
  `not_applied`) in its result. The chat shows the reply under the message, and the steered task's
  answer below it. Steer tasks from before this change (no `steer_reply_status`) keep their hidden
  acknowledgement.
- **Channels:** the reply is sent as a message in the same chat or thread; a follow-up has its own
  correlation ID.

No configuration is needed or added.

## 4) Implementation

- `runtimecontrol.SteerQueue.PushTicket` returns a `SteerTicket` that resolves to applied (the run
  drained it), dropped (the queue closed) or stopped (a stop closed it).
- `RunControl.Steer` keeps the run's task, conversation and progress snapshot with the result, and
  says why input was not queued (`SteerResult.Reason`).
- `runtimecontrol.SteerResponder` holds a FIFO lane per conversation, a concurrency bound, the
  ticket checks before and after writing, and the follow-up watcher.
  `runtimecontrol.LLMSteerReplier` and `MeaningfulSteerReply` write and validate replies.
- `channelruntime/core.NewGenerationSteerResponder` is the channels' responder;
  `core.SteerConversation` turns chat history into the reply's conversation.

## 5) Limits

- A follow-up for a message dropped after its reply goes out as a second message; in Console it is
  appended to the steer task's output and shows once the history is refreshed.
- The reply is written when the message arrives, before the run takes it in, so it states intent,
  not results.
- Channel runs keep no progress snapshot, so their replies are written without one.
