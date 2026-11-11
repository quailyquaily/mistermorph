package consolecmd

import (
	"context"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/awareness"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/textutil"
	"github.com/quailyquaily/mistermorph/internal/workspace"
)

func (r *consoleLocalRuntime) regenerateTopicTitle(ctx context.Context, generation *consoleLocalRuntimeGeneration, topicID string) (daemonruntime.TopicInfo, error) {
	if r == nil || r.store == nil || generation == nil {
		return daemonruntime.TopicInfo{}, fmt.Errorf("console runtime generation is not initialized")
	}
	topicID = strings.TrimSpace(topicID)
	if topicID == "" || !daemonruntime.TopicNameRegenerable(topicID) {
		return daemonruntime.TopicInfo{}, daemonruntime.BadRequest("topic cannot be renamed")
	}
	if _, busy := r.topicTitleRegenerations.LoadOrStore(topicID, struct{}{}); busy {
		return daemonruntime.TopicInfo{}, daemonruntime.ErrTopicTitleBusy
	}
	defer r.topicTitleRegenerations.Delete(topicID)

	input := consoleTopicTitleInput(r.store.TopicTitleTasks(topicID, 6))
	if input == "" {
		return daemonruntime.TopicInfo{}, daemonruntime.BadRequest("topic has no conversation to name")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if r.consoleExecutionState != nil && r.workersCtx != nil {
		stop := context.AfterFunc(r.workersCtx, cancel)
		defer stop()
	}
	if err := ctx.Err(); err != nil {
		return daemonruntime.TopicInfo{}, err
	}
	started, err := r.store.BeginTopicTitleRegeneration(topicID)
	if err != nil {
		return daemonruntime.TopicInfo{}, err
	}
	generation.acquire()
	defer generation.release()
	title, err := r.generateTopicTitle(ctx, generation, input)
	if err != nil {
		return daemonruntime.TopicInfo{}, err
	}
	if err := ctx.Err(); err != nil {
		return daemonruntime.TopicInfo{}, err
	}
	return r.store.CompleteTopicTitleRegeneration(topicID, started.TitleRevision, title.Title, title.Icon)
}

// suggestTopicTitle generates a title for one of a person's topics from its conversation, the way
// regenerateTopicTitle does, and saves nothing: the rename dialog puts it in its field as a draft,
// and only a save names the topic. It does not move the title revision either, so naming that is
// under way is not disturbed by a look at a suggestion.
func (r *consoleLocalRuntime) suggestTopicTitle(ctx context.Context, generation *consoleLocalRuntimeGeneration, topicID string) (daemonruntime.TopicTitleSuggestion, error) {
	if r == nil || r.store == nil || generation == nil {
		return daemonruntime.TopicTitleSuggestion{}, fmt.Errorf("console runtime generation is not initialized")
	}
	topicID = strings.TrimSpace(topicID)
	if !daemonruntime.TopicRenamable(topicID) {
		return daemonruntime.TopicTitleSuggestion{}, daemonruntime.BadRequest("topic cannot be renamed")
	}
	input := consoleTopicTitleInput(r.store.TopicTitleTasks(topicID, 6))
	if input == "" {
		return daemonruntime.TopicTitleSuggestion{}, daemonruntime.BadRequest("topic has no conversation to name")
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	if r.consoleExecutionState != nil && r.workersCtx != nil {
		stop := context.AfterFunc(r.workersCtx, cancel)
		defer stop()
	}
	if err := ctx.Err(); err != nil {
		return daemonruntime.TopicTitleSuggestion{}, err
	}
	generation.acquire()
	defer generation.release()
	title, err := r.generateTopicTitle(ctx, generation, input)
	if err != nil {
		return daemonruntime.TopicTitleSuggestion{}, err
	}
	if err := ctx.Err(); err != nil {
		return daemonruntime.TopicTitleSuggestion{}, err
	}
	return daemonruntime.TopicTitleSuggestion{Title: title.Title, Icon: title.Icon}, nil
}

// recordCronTopicRun keeps what a TODO item's topic shows from its item, since a one-time item is
// gone once it has run, and gives the topic its icon. A failure here costs the display, not the run.
func (r *consoleLocalRuntime) recordCronTopicRun(generation *consoleLocalRuntimeGeneration, run awareness.TopicRun) {
	if r == nil || r.store == nil || !daemonruntime.IsCronTopicID(run.TopicID) {
		return
	}
	logger := r.currentLogger()
	if err := r.store.SetCronTopicRunModel(run.TopicID, run.Provider, run.Model); err != nil {
		logger.Debug("console_cron_topic_model_update_failed", "topic_id", run.TopicID, "error", err.Error())
	}
	if store := r.currentWorkspaceStore(); store != nil {
		key := buildConsoleConversationKey(run.TopicID)
		var err error
		if dir := strings.TrimSpace(run.WorkspaceDir); dir != "" {
			_, _, err = store.Set(key, workspace.Attachment{WorkspaceDir: dir})
		} else {
			_, _, err = store.Delete(key)
		}
		if err != nil {
			logger.Debug("console_cron_topic_workspace_update_failed", "topic_id", run.TopicID, "error", err.Error())
		}
	}
	r.maybeGenerateCronTopicIcon(generation, run.TopicID, run.Task)
}

// maybeGenerateCronTopicIcon gives a TODO item's topic its icon, from the item's task, the way a
// person's topic gets one from its first message: once, in the background, while the run works. A
// run whose generation fails leaves it to the next run.
func (r *consoleLocalRuntime) maybeGenerateCronTopicIcon(generation *consoleLocalRuntimeGeneration, topicID, task string) {
	if r == nil || r.store == nil || generation == nil || !daemonruntime.IsCronTopicID(topicID) {
		return
	}
	task = strings.TrimSpace(task)
	if task == "" {
		return
	}
	topic, ok := r.store.GetTopic(topicID)
	if !ok || topic == nil || topic.DeletedAt != nil || topic.LLMTitleGeneratedAt != nil {
		return
	}
	if _, busy := r.topicTitleRegenerations.LoadOrStore(topicID, struct{}{}); busy {
		return
	}
	ctx := context.Background()
	if r.consoleExecutionState != nil && r.workersCtx != nil {
		ctx = r.workersCtx
	}
	generation.acquire()
	go func() {
		defer generation.release()
		defer r.topicTitleRegenerations.Delete(topicID)
		title, err := r.generateTopicTitle(ctx, generation, textutil.TruncateRunes(task, 1200))
		if err != nil {
			r.currentLogger().Debug("console_cron_topic_icon_generate_failed", "topic_id", topicID, "error", err.Error())
			return
		}
		if err := r.store.SetCronTopicIconFromLLM(topicID, title.Icon); err != nil {
			r.currentLogger().Debug("console_cron_topic_icon_update_failed", "topic_id", topicID, "error", err.Error())
		}
	}()
}

func consoleTopicTitleInput(tasks []daemonruntime.TaskInfo) string {
	var input strings.Builder
	for _, task := range tasks {
		text := strings.TrimSpace(task.Task)
		if text == "" {
			continue
		}
		input.WriteString("User: ")
		input.WriteString(textutil.TruncateRunes(text, 600))
		input.WriteByte('\n')
		if task.Status != daemonruntime.TaskDone || task.SteerTargetTaskID != "" {
			continue
		}
		if reply := chathistory.TaskResultOutput(task.Result); reply != "" {
			input.WriteString("Assistant: ")
			input.WriteString(textutil.TruncateRunes(reply, 400))
			input.WriteByte('\n')
		}
	}
	return strings.TrimSpace(input.String())
}
