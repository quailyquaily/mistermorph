package consolecmd

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// Editing a message (POST /tasks/{id}/replace): the person changes one of their earlier messages
// in a topic and the conversation starts again from there. The edited message and everything after
// it go, in the store and so in every later prompt (the history is built from the topic's tasks),
// and the new text runs as a new task in their place. This is a replacement, not a branch: nothing
// of the old continuation is kept.
//
//   - Nothing in the topic may be running or waiting (an approval, a question): an edit is refused
//     (ErrTopicRunning, 409) rather than stopping that work. The check and the replacement are one
//     step under the store's lock, so a message sent meanwhile either makes the edit fail or comes
//     after it.
//   - The replacement is one journal event (ConsoleFileStore.ReplaceTopicTasks): until it is
//     written nothing is dropped, so a refused or failed edit leaves the conversation as it was.
//   - The edited message keeps the files it carried: they go with the new text, checked again as
//     any attachment is. The composer adds no files to an edit.
//   - Commands are neither edited nor sent as an edit: they act on the runtime, not the
//     conversation. `/think` is a way of asking, so a message with it is a message.
//   - A context checkpoint (a compaction summary) that covered a dropped turn is let go by the
//     replacement's run: its boundary is no longer in the history (contextcheckpoint.PrepareHistory).
//     The coder sessions of the conversation, which remember the dropped turns, are reset here.
func (r *consoleLocalRuntime) replaceTaskWithGeneration(ctx context.Context, generation *consoleLocalRuntimeGeneration, req daemonruntime.ReplaceTaskRequest) (daemonruntime.ReplaceTaskResponse, error) {
	releaseGeneration := true
	defer func() {
		if releaseGeneration {
			generation.release()
		}
	}()
	if r == nil || r.store == nil {
		return daemonruntime.ReplaceTaskResponse{}, fmt.Errorf("console runtime is not initialized")
	}
	targetID := strings.TrimSpace(req.TaskID)
	topicID := strings.TrimSpace(req.TopicID)
	task := strings.TrimSpace(req.Task)
	switch {
	case task == "":
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.BadRequest("missing task")
	case targetID == "":
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.BadRequest("missing task_id")
	case topicID == "":
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.BadRequest("missing topic_id")
	case daemonruntime.IsAgentLinkTopicID(topicID), daemonruntime.IsCronTopicID(topicID), topicID == daemonruntime.ConsoleAwarenessTopicID:
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.BadRequest("messages in this topic can't be edited")
	}
	if topic, ok := r.store.GetTopic(topicID); !ok || topic == nil || topic.DeletedAt != nil {
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.ErrTopicNotFound
	}
	target, ok := r.store.Get(targetID)
	if !ok || target == nil || strings.TrimSpace(target.TopicID) != topicID {
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.ErrMessageNotFound
	}
	if strings.TrimSpace(target.Task) == "" {
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.BadRequest("only a message with text can be edited")
	}
	if consoleCommandMessage(target.Task) {
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.BadRequest("a command can't be edited; send it again instead")
	}
	if consoleCommandMessage(task) {
		return daemonruntime.ReplaceTaskResponse{}, daemonruntime.BadRequest("a message can't be edited into a command; send the command as a new message")
	}
	timeout := consoleDefaultTimeoutFromReader(generation.reader)
	if raw := strings.TrimSpace(req.Timeout); raw != "" {
		d, err := time.ParseDuration(raw)
		if err != nil || d <= 0 {
			return daemonruntime.ReplaceTaskResponse{}, daemonruntime.BadRequest("invalid timeout (use Go duration like 2m, 30s)")
		}
		timeout = d
	}
	trigger := normalizeConsoleTrigger(req.Trigger, daemonruntime.TaskTrigger{
		Source: "ui",
		Event:  "chat_edit",
		Ref:    "web/console",
	})
	job, resp, removed, err := r.acceptTaskReplacing(
		generation,
		task,
		strings.TrimSpace(req.Model),
		strings.TrimSpace(req.LLMProfile),
		timeout,
		topicID,
		"",
		"",
		target.FileReferences,
		trigger,
		targetID,
	)
	if err != nil {
		return daemonruntime.ReplaceTaskResponse{}, err
	}
	// The coder sessions remember the dropped turns; the replacement starts them afresh.
	if bundle := generation.bundle; bundle != nil && bundle.taskRuntime != nil {
		bundle.taskRuntime.CoderSessions.Reset(job.ConversationKey)
	}
	resp, ownershipTransferred, err := r.publishAcceptedTask(ctx, job, resp)
	if ownershipTransferred {
		releaseGeneration = false
	}
	if err != nil {
		return daemonruntime.ReplaceTaskResponse{}, err
	}
	return daemonruntime.ReplaceTaskResponse{
		ID:             resp.ID,
		Status:         resp.Status,
		TopicID:        resp.TopicID,
		ReplacedTaskID: targetID,
		RemovedTaskIDs: removed,
	}, nil
}

// consoleCommandMessage reports whether text is a runtime command (`/reset`, `/model ...`) rather
// than a message; `/think` asks for a harder think about a message, so it is a message.
func consoleCommandMessage(text string) bool {
	word, _ := chatcommands.ParseCommand(strings.TrimSpace(text))
	command := chatcommands.NormalizeCommand(word)
	return command != "" && command != "/think"
}
