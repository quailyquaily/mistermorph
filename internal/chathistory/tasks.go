package chathistory

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func BuildTaskHistory(tasks []taskdomain.TaskInfo, job taskdomain.TaskInfo, limit int) []ChatHistoryItem {
	if limit <= 0 || len(tasks) == 0 {
		return nil
	}
	prior := make([]taskdomain.TaskInfo, 0, limit)
	for _, task := range tasks {
		if !taskPrecedes(task, job) {
			continue
		}
		command, _ := chatcommands.ParseCommand(task.Task)
		if chatcommands.NormalizeCommand(command) == "/reset" && task.Status == taskdomain.TaskDone {
			break
		}
		if chatcommands.IsContextCompactCommand(task.Task) {
			continue
		}
		userText := strings.TrimSpace(task.Task)
		replyText := TaskReplyText(task)
		if userText == "" && replyText == "" {
			continue
		}
		prior = append(prior, task)
		if len(prior) == limit {
			break
		}
	}
	for left, right := 0, len(prior)-1; left < right; left, right = left+1, right-1 {
		prior[left], prior[right] = prior[right], prior[left]
	}
	history := make([]ChatHistoryItem, 0, len(prior)*2)
	for _, task := range prior {
		if inbound := TaskInbound(task); strings.TrimSpace(inbound.Text) != "" {
			history = append(history, inbound)
		}
		if strings.TrimSpace(task.SteerTargetTaskID) == "" {
			if outbound, ok := TaskOutbound(task); ok {
				history = append(history, outbound)
			}
		}
	}
	sort.SliceStable(history, func(left, right int) bool {
		leftAt := history[left].SentAt
		rightAt := history[right].SentAt
		if leftAt.Equal(rightAt) {
			return false
		}
		if leftAt.IsZero() {
			return true
		}
		if rightAt.IsZero() {
			return false
		}
		return leftAt.Before(rightAt)
	})
	return history
}

func taskPrecedes(task taskdomain.TaskInfo, job taskdomain.TaskInfo) bool {
	taskID := strings.TrimSpace(task.ID)
	if taskID == "" || taskID == strings.TrimSpace(job.ID) {
		return false
	}
	if job.CreatedAt.IsZero() {
		return true
	}
	if task.CreatedAt.IsZero() {
		return false
	}
	return task.CreatedAt.UTC().Before(job.CreatedAt.UTC())
}

func TaskInbound(task taskdomain.TaskInfo) ChatHistoryItem {
	return ChatHistoryItem{
		Channel:   "console",
		Kind:      KindInboundUser,
		ChatID:    "console:" + task.TopicID,
		ChatType:  "private",
		MessageID: strings.TrimSpace(task.ID),
		SentAt:    taskInboundSentAt(task),
		Sender: ChatHistorySender{
			UserID:     "console:user",
			Username:   "console",
			Nickname:   "Console User",
			DisplayRef: "console:user",
		},
		Text: strings.TrimSpace(task.Task),
	}
}

func TaskOutbound(task taskdomain.TaskInfo) (ChatHistoryItem, bool) {
	text := TaskReplyText(task)
	if text == "" {
		return ChatHistoryItem{}, false
	}
	return ChatHistoryItem{
		Channel:          "console",
		Kind:             KindOutboundAgent,
		ChatID:           "console:" + task.TopicID,
		ChatType:         "private",
		ReplyToMessageID: strings.TrimSpace(task.ID),
		SentAt:           taskOutboundSentAt(task),
		Sender: ChatHistorySender{
			UserID:     "0",
			Username:   "agent",
			Nickname:   "MisterMorph",
			IsBot:      true,
			DisplayRef: "agent",
		},
		Text: text,
	}, true
}

func taskInboundSentAt(task taskdomain.TaskInfo) time.Time {
	sentAt := task.CreatedAt.UTC()
	if sentAt.IsZero() {
		return time.Now().UTC()
	}
	return sentAt
}

func taskOutboundSentAt(task taskdomain.TaskInfo) time.Time {
	if task.FinishedAt != nil && !task.FinishedAt.IsZero() {
		return task.FinishedAt.UTC()
	}
	if task.ResumedAt != nil && !task.ResumedAt.IsZero() {
		return task.ResumedAt.UTC()
	}
	if task.PendingAt != nil && !task.PendingAt.IsZero() {
		return task.PendingAt.UTC()
	}
	if task.StartedAt != nil && !task.StartedAt.IsZero() {
		return task.StartedAt.UTC()
	}
	return taskInboundSentAt(task)
}

func TaskReplyText(task taskdomain.TaskInfo) string {
	if text := TaskResultOutput(task.Result); text != "" {
		return text
	}
	return strings.TrimSpace(task.Error)
}

func TaskResultOutput(result any) string {
	switch value := result.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(value)
	case agent.Final:
		return TaskResultOutput(value.Output)
	case *agent.Final:
		if value == nil {
			return ""
		}
		return TaskResultOutput(value.Output)
	case map[string]any:
		if nested, ok := value["final"]; ok {
			if text := TaskResultOutput(nested); text != "" {
				return text
			}
		}
		if output, ok := value["output"]; ok {
			return stringifyTaskResultValue(output)
		}
	}
	return ""
}

func stringifyTaskResultValue(value any) string {
	switch raw := value.(type) {
	case nil:
		return ""
	case string:
		return strings.TrimSpace(raw)
	default:
		data, err := json.Marshal(raw)
		if err != nil {
			return strings.TrimSpace(fmt.Sprint(raw))
		}
		return strings.TrimSpace(string(data))
	}
}
