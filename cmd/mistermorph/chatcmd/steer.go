package chatcmd

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
	"github.com/quailyquaily/mistermorph/llm"
)

const chatSteerRuntime = "chat"

// chatTurnSteering is how a turn takes messages sent while it runs: a run control holding just the
// turn, so they are queued for it and replied to like steered messages elsewhere.
type chatTurnSteering struct {
	control *runtimecontrol.RunControl
	replies *runtimecontrol.SteerResponder
	key     string
	runID   string
}

// attachTurnSteering makes queue take turn's steered messages, replied to with route's model until
// ctx ends. A resumed turn gets a new queue; replies keep their order across both.
func (s *chatSession) attachTurnSteering(ctx context.Context, turn *activeChatTurn, queue *runtimecontrol.SteerQueue, cancel context.CancelCauseFunc, history []llm.Message, route llmutil.ResolvedRoute, model string) {
	if turn == nil || queue == nil {
		return
	}
	previous := turn.steering
	steering := &chatTurnSteering{control: runtimecontrol.New(), key: s.conversationKey(), runID: strings.TrimSpace(turn.runID)}
	if steering.key == "" {
		steering.key = chatSteerRuntime
	}
	if steering.runID == "" {
		steering.runID = llmstats.NewSyntheticRunID("chat")
	}
	if previous != nil {
		previous.control.Finish(chatSteerRuntime, previous.key, previous.runID)
		steering.replies = previous.replies
	} else {
		replier := s.steerReplier
		if replier == nil {
			replier = s.chatSteerReplier(route, model)
		}
		steering.replies = runtimecontrol.NewSteerResponder(ctx, replier, runtimecontrol.SteerResponderOptions{Logger: s.logger})
	}
	if err := steering.control.Start(runtimecontrol.ActiveRun{
		Runtime:         chatSteerRuntime,
		ConversationKey: steering.key,
		TaskID:          steering.runID,
		RunID:           steering.runID,
		Cancel:          cancel,
		SteerQueue:      queue,
		Task:            turn.runInput,
		Conversation:    chatSteerConversation(history),
	}); err != nil {
		if s.logger != nil {
			s.logger.Warn("chat_steer_attach_failed", "error", err.Error())
		}
		turn.steering = nil
		return
	}
	turn.steering = steering
}

// chatSteerReplier writes replies with a client of its own for route: the turn's clients close
// when it ends, and a reply may still be under way.
func (s *chatSession) chatSteerReplier(route llmutil.ResolvedRoute, model string) runtimecontrol.SteerReplyFunc {
	return func(ctx context.Context, req runtimecontrol.SteerReplyRequest) (string, error) {
		if s == nil || s.taskRuntime == nil {
			return "", fmt.Errorf("chat runtime is not initialized")
		}
		client, err := s.taskRuntime.CreateClientForRoute(route)
		if closer, ok := client.(io.Closer); ok {
			defer func() { _ = closer.Close() }()
		}
		if err != nil {
			return "", err
		}
		ctx = llmstats.WithRunID(ctx, req.TaskID)
		return runtimecontrol.LLMSteerReplier(client, model)(ctx, req)
	}
}

func chatSteerConversation(history []llm.Message) []runtimecontrol.ConversationLine {
	lines := make([]runtimecontrol.ConversationLine, 0, len(history))
	for _, message := range history {
		if text := strings.TrimSpace(message.Content); text != "" {
			lines = append(lines, runtimecontrol.ConversationLine{Role: message.Role, Text: text})
		}
	}
	return lines
}

// steerActiveTurn steers input into turn and shows the reply through show once it is written. In a
// shared topic, the message and its reply are recorded as a task steered into the turn's task.
func (s *chatSession) steerActiveTurn(turn *activeChatTurn, input string, show func(text string)) error {
	var result runtimecontrol.SteerResult
	if turn != nil && turn.steering != nil {
		result = turn.steering.control.Steer(chatSteerRuntime, turn.steering.key, input)
	}
	if !result.Found {
		// The turn takes no more messages: it is ending.
		show(runtimecontrol.SteerRejectedText(runtimecontrol.SteerRejectedFinishing))
		return nil
	}
	recordID, recordErr := s.recordLocalSteer(turn, input, result)
	respondErr := turn.steering.replies.Respond(result, func(_ context.Context, reply runtimecontrol.SteerReply) error {
		show(reply.Text)
		return s.finishLocalSteer(recordID, reply)
	})
	if recordErr != nil {
		return recordErr
	}
	return respondErr
}

// recordLocalSteer records a message steered into a shared topic's turn as a task running until
// its reply is written, and returns the task's ID ("" outside a shared topic). A message that did
// not reach the turn is recorded done at once, with what kept it out: it steers nothing, and the
// topic holds one running chat task.
func (s *chatSession) recordLocalSteer(turn *activeChatTurn, input string, result runtimecontrol.SteerResult) (string, error) {
	if s.sharedTopics == nil || turn == nil || turn.sharedTask == nil {
		return "", nil
	}
	now := time.Now().UTC()
	task := daemonruntime.TaskInfo{ID: llmstats.NewSyntheticRunID("chat-steer"), TopicID: turn.sharedTask.TopicID, Task: input, Status: daemonruntime.TaskRunning, CreatedAt: now, StartedAt: &now}
	if result.Queued {
		task.SteerTargetTaskID = turn.sharedTask.ID
	} else {
		task.Status, task.FinishedAt = daemonruntime.TaskDone, &now
		task.Result = map[string]any{"final": &agent.Final{Output: runtimecontrol.SteerRejectedText(result.Reason)}, "steer_reply_status": string(runtimecontrol.SteerNotQueued)}
	}
	if err := s.sharedTopics.UpsertWithTrigger(task, daemonruntime.TaskTrigger{Source: "chat", Ref: s.chatOwner, Event: "chat_steer"}, ""); err != nil {
		return "", err
	}
	return task.ID, nil
}

// finishLocalSteer gives a recorded steered message its reply; a later notice that the turn
// dropped the message is added to it.
func (s *chatSession) finishLocalSteer(taskID string, reply runtimecontrol.SteerReply) error {
	if taskID == "" || s.sharedTopics == nil {
		return nil
	}
	now := time.Now().UTC()
	return s.sharedTopics.Update(taskID, func(info *daemonruntime.TaskInfo) {
		text := strings.TrimSpace(reply.Text)
		if reply.Followup {
			if previous := chathistory.TaskResultOutput(info.Result); previous != "" {
				text = previous + "\n\n" + text
			}
		}
		info.Status = daemonruntime.TaskDone
		info.Error = ""
		info.FinishedAt = &now
		info.Result = map[string]any{"final": &agent.Final{Output: text}, "steer_reply_status": string(reply.Status)}
	})
}
