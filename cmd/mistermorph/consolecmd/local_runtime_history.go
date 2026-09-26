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

func (r *consoleLocalRuntime) loadConsoleTopicHistory(job consoleLocalTaskJob) []chathistory.ChatHistoryItem {
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
	return buildConsoleTopicHistory(tasks, job, consoleHistoryRestoreTaskLimit)
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
