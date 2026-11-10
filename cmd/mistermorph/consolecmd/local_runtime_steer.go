package consolecmd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"time"

	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

// steerResponder replies to messages steered into the Console's running tasks.
func (r *consoleLocalRuntime) steerResponder() *runtimecontrol.SteerResponder {
	r.steerRepliesOnce.Do(func() {
		ctx := context.Background()
		if r.consoleExecutionState != nil && r.workersCtx != nil {
			ctx = r.workersCtx
		}
		r.steerReplies = runtimecontrol.NewSteerResponder(ctx, r.writeSteerReply, runtimecontrol.SteerResponderOptions{Logger: r.currentLogger()})
	})
	return r.steerReplies
}

// writeSteerReply writes the reply to a steered message with the model the task it steers runs
// with: the task's model and LLM profile, or else the main model.
func (r *consoleLocalRuntime) writeSteerReply(ctx context.Context, req runtimecontrol.SteerReplyRequest) (string, error) {
	generation, err := r.captureGeneration()
	if err != nil {
		return "", err
	}
	defer generation.release()
	if generation.commonDeps.CreateLLMClient == nil {
		return "", fmt.Errorf("console runtime generation is not initialized")
	}
	model, profile := "", ""
	if r.store != nil {
		if target, ok := r.store.Get(req.TaskID); ok && target != nil {
			model, profile = target.Model, target.LLMProfile
		}
	}
	route, model, err := resolveConsoleAdmittedRoute(generation, "", model, profile, req.TaskID)
	if err != nil {
		return "", err
	}
	client, err := generation.commonDeps.CreateLLMClient(route)
	if closer, ok := client.(io.Closer); ok {
		defer func() {
			if closeErr := closer.Close(); closeErr != nil && generation.logger != nil {
				generation.logger.Warn("console_steer_reply_client_close_failed", "error", closeErr.Error())
			}
		}()
	}
	if err != nil {
		return "", err
	}
	// The reply's usage counts with the task it replies about.
	ctx = llmstats.WithRunID(ctx, req.TaskID)
	return runtimecontrol.LLMSteerReplier(client, model)(ctx, req)
}

// steerConsoleConversation is the conversation before job, for replies to messages steered into it.
func (r *consoleLocalRuntime) steerConsoleConversation(job consoleLocalTaskJob) []runtimecontrol.ConversationLine {
	if r == nil || r.store == nil {
		return nil
	}
	return runtimecore.SteerConversation(r.loadConsoleTopicHistory(job))
}

// submitSteerTask records a message steered into a running task as a task of its own, running
// until its reply is written. The reply, or what kept the message from the task, is its output.
func (r *consoleLocalRuntime) submitSteerTask(generation *consoleLocalRuntimeGeneration, result runtimecontrol.SteerResult, task string, timeout time.Duration, topicID string, topicTitle string, workspaceDir string, trigger daemonruntime.TaskTrigger) (daemonruntime.SubmitTaskResponse, error) {
	job, _, err := r.acceptTask(generation, task, "", "", timeout, topicID, topicTitle, workspaceDir, nil, trigger)
	if err != nil {
		return daemonruntime.SubmitTaskResponse{}, err
	}
	// The message moves the target's reply below it only when the message reached the target.
	steerTargetTaskID := ""
	if result.Queued {
		steerTargetTaskID = strings.TrimSpace(result.TaskID)
	}
	startedAt := time.Now().UTC()
	updater := r.taskStateUpdater()
	if err := updater.Update(job.TaskID, func(info *daemonruntime.TaskInfo) {
		info.Status = daemonruntime.TaskRunning
		info.StartedAt = &startedAt
		info.SteerTargetTaskID = steerTargetTaskID
	}); err != nil {
		return daemonruntime.SubmitTaskResponse{}, err
	}
	steerTaskID := job.TaskID
	respondErr := r.steerResponder().Respond(result, func(_ context.Context, reply runtimecontrol.SteerReply) error {
		return r.finishSteerTask(steerTaskID, reply)
	})
	if respondErr != nil {
		_ = r.finishSteerTask(steerTaskID, runtimecontrol.SteerReply{Text: "Your message could not be handled: " + respondErr.Error(), Status: runtimecontrol.SteerReplyFailed})
		return daemonruntime.SubmitTaskResponse{}, respondErr
	}
	return daemonruntime.SubmitTaskResponse{
		ID:                job.TaskID,
		Status:            daemonruntime.TaskRunning,
		TopicID:           job.TopicID,
		SteerTargetTaskID: steerTargetTaskID,
	}, nil
}

// finishSteerTask gives a steered message's task its reply. A notice that the target dropped the
// message after the reply was given is added to the reply.
func (r *consoleLocalRuntime) finishSteerTask(taskID string, reply runtimecontrol.SteerReply) error {
	text := strings.TrimSpace(reply.Text)
	if text == "" {
		return errors.New("steer reply is empty")
	}
	finishedAt := time.Now().UTC()
	return r.taskStateUpdater().Update(taskID, func(info *daemonruntime.TaskInfo) {
		if reply.Followup {
			if previous := chathistory.TaskResultOutput(info.Result); previous != "" {
				text = previous + "\n\n" + text
			}
		}
		info.Status = daemonruntime.TaskDone
		info.Error = ""
		info.FinishedAt = &finishedAt
		info.Result = map[string]any{
			"final": map[string]any{
				"output": text,
			},
			"steer_reply_status": string(reply.Status),
		}
	})
}
