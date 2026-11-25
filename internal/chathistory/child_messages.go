package chathistory

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

// ChildMessagesResultKey is the key of a task's result that holds the messages the person sent its
// subagents directly while it ran (runtimecontrol.ChildMessage), with what became of each.
const ChildMessagesResultKey = "child_messages"

// TaskChildMessage is one message the person sent a task's subagent, as the task's result keeps it.
type TaskChildMessage struct {
	ChildID     string    `json:"child_id"`
	ChildTaskID string    `json:"child_task_id"`
	ChildName   string    `json:"child_name,omitempty"`
	Text        string    `json:"text"`
	Status      string    `json:"status"`
	QueuedAt    time.Time `json:"queued_at"`
	Step        int       `json:"step,omitempty"`
}

// TaskChildMessages reads the messages the person sent the task's subagents from its result,
// oldest first.
func TaskChildMessages(result any) []TaskChildMessage {
	if result == nil {
		return nil
	}
	data, err := json.Marshal(result)
	if err != nil {
		return nil
	}
	var decoded struct {
		Messages []TaskChildMessage `json:"child_messages"`
	}
	if json.Unmarshal(data, &decoded) != nil {
		return nil
	}
	out := make([]TaskChildMessage, 0, len(decoded.Messages))
	for _, message := range decoded.Messages {
		message.Text = strings.TrimSpace(message.Text)
		if message.Text == "" {
			continue
		}
		out = append(out, message)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].QueuedAt.Before(out[j].QueuedAt) })
	return out
}

// TaskChildMessageItems are the messages the person sent the task's subagents, as messages from
// the person in the topic's history, each saying which subagent it went to and whether it took it.
func TaskChildMessageItems(task taskdomain.TaskInfo) []ChatHistoryItem {
	messages := TaskChildMessages(task.Result)
	if len(messages) == 0 {
		return nil
	}
	out := make([]ChatHistoryItem, 0, len(messages))
	for i, message := range messages {
		item := TaskInbound(task)
		item.MessageID = fmt.Sprintf("%s:child:%d", strings.TrimSpace(task.ID), i+1)
		if !message.QueuedAt.IsZero() {
			item.SentAt = message.QueuedAt.UTC()
		}
		item.Text = ChildMessageHistoryText(message)
		out = append(out, item)
	}
	return out
}

// ChildMessageHistoryText is a message sent to a subagent as the topic's history tells it.
func ChildMessageHistoryText(message TaskChildMessage) string {
	name := strings.TrimSpace(message.ChildName)
	id := strings.TrimSpace(message.ChildID)
	if id == "" {
		id = strings.TrimSpace(message.ChildTaskID)
	}
	who := "a subagent"
	switch {
	case name != "" && id != "":
		who = fmt.Sprintf("the subagent %s (%s)", name, id)
	case name != "":
		who = "the subagent " + name
	case id != "":
		who = "the subagent " + id
	}
	outcome := "it finished before taking it in, so it was not applied"
	if message.Status == "applied" {
		outcome = "it took it in"
		if message.Step > 0 {
			outcome = fmt.Sprintf("it took it in at its step %d", message.Step)
		}
	}
	return fmt.Sprintf("[Sent directly to %s while it ran; %s]\n%s", who, outcome, strings.TrimSpace(message.Text))
}
