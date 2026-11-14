package consolecmd

import (
	"log/slog"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/channelruntime/imageinput"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/llm"
)

const (
	consoleHistoryRestoreTaskLimit = 6
	consoleHistoryRestoreScanLimit = 200
)

// loadConsoleTopicHistory is what was said in the topic before job: for the short requests beside
// a run (the lightweight decision, a steer's reply), which go by the conversation alone.
func (r *consoleLocalRuntime) loadConsoleTopicHistory(job consoleLocalTaskJob) []chathistory.ChatHistoryItem {
	return r.consoleTopicHistory(job, false)
}

// loadConsoleRunHistory is the history a run starts from: the conversation, and with each
// finished turn a record of the tool calls the agent made in it (chathistory.TaskToolRecord), so
// it can answer from what its tools returned and does not take an earlier turn for one without calls.
func (r *consoleLocalRuntime) loadConsoleRunHistory(job consoleLocalTaskJob) []chathistory.ChatHistoryItem {
	return r.consoleTopicHistory(job, true)
}

func (r *consoleLocalRuntime) consoleTopicHistory(job consoleLocalTaskJob, toolRecords bool) []chathistory.ChatHistoryItem {
	if r == nil || r.store == nil {
		return nil
	}
	topicID := strings.TrimSpace(job.TopicID)
	if topicID == "" {
		topicID = daemonruntime.ConsoleDefaultTopicID
	}
	tasks := r.store.List(daemonruntime.TaskListOptions{
		TopicID: topicID,
		Limit:   consoleHistoryRestoreScanLimit,
	})
	current := daemonruntime.TaskInfo{ID: job.TaskID, CreatedAt: job.CreatedAt}
	if toolRecords {
		return chathistory.BuildTaskHistoryWithToolRecords(tasks, current, consoleHistoryRestoreTaskLimit)
	}
	return chathistory.BuildTaskHistory(tasks, current, consoleHistoryRestoreTaskLimit)
}

func renderConsolePromptMessages(history []chathistory.ChatHistoryItem, job consoleLocalTaskJob, model string, supportsImageParts *bool, imagePaths []string, logger *slog.Logger) ([]llm.Message, *llm.Message, error) {
	historyMsgs := chathistory.RenderHistoryMessages(history)
	currentRaw := chathistory.RenderCurrentMessage(newConsoleInboundHistoryItem(job))
	currentMsg, err := imageinput.BuildUserMessage(currentRaw, model, imagePaths, imageinput.MessageOptions{
		MaxImages:          consoleLLMMaxImages,
		MaxBytes:           consoleLLMMaxImageBytes,
		SupportsImageParts: supportsImageParts,
		Logger:             logger,
		LogPrefix:          "console",
	})
	if err != nil {
		return nil, nil, err
	}
	return historyMsgs, &currentMsg, nil
}

func buildConsoleTopicHistory(tasks []daemonruntime.TaskInfo, job consoleLocalTaskJob, limit int) []chathistory.ChatHistoryItem {
	return chathistory.BuildTaskHistory(tasks, daemonruntime.TaskInfo{ID: job.TaskID, CreatedAt: job.CreatedAt}, limit)
}

func newConsoleInboundHistoryItem(job consoleLocalTaskJob) chathistory.ChatHistoryItem {
	return chathistory.TaskInbound(daemonruntime.TaskInfo{ID: job.TaskID, TopicID: job.TopicID, Task: job.Task, CreatedAt: job.CreatedAt})
}
