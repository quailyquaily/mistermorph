package chatcmd

import (
	"errors"
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

// chatSteerCommand sends a message to one subagent of the running task: /steer <child-id> <text>.
// The child takes it in at its next step; a child that cannot take it is named with the reason,
// and nothing is sent.
const chatSteerCommand = "/steer"

const chatSteerDescription = "send a message to a running subagent <id> <message>"

const chatSteerUsage = "Usage: /steer <child-id> <message>. /agents lists the running task's subagents and their IDs."

// parseSteerChildArgs splits /steer's arguments into the child's ID and the message.
func parseSteerChildArgs(args string) (string, string, error) {
	args = strings.TrimSpace(args)
	if args == "" {
		return "", "", errors.New(chatSteerUsage)
	}
	id, text := args, ""
	if i := strings.IndexAny(args, " \t\n"); i >= 0 {
		id, text = args[:i], args[i+1:]
	}
	id, text = strings.TrimSpace(id), strings.TrimSpace(text)
	if id == "" || text == "" {
		return "", "", errors.New(chatSteerUsage)
	}
	return id, text, nil
}

// resolveSteerChildID is the full ID of the retained subagent id names: its ID or a unique prefix
// (as /agents takes them). A worker ID ("worker-2"), or an ID no retained record matches, goes to
// the runtime as given; it answers for a child it does not know.
func resolveSteerChildID(rows []chatAgentRecord, id string) (string, error) {
	id = strings.TrimSpace(id)
	if strings.HasPrefix(id, "worker-") {
		return id, nil
	}
	row, err := findChatAgent(rows, id)
	if err == nil {
		return row.ID, nil
	}
	if strings.Contains(err.Error(), "ambiguous") {
		return "", err
	}
	return id, nil
}

// steerChildCommand handles /steer for a local session: it queues the message for the subagent of
// turn, the running turn (nil when none runs), and returns what to show.
func (s *chatSession) steerChildCommand(turn *activeChatTurn, args string, rows []chatAgentRecord) (string, error) {
	id, text, err := parseSteerChildArgs(args)
	if err != nil {
		return "", err
	}
	id, err = resolveSteerChildID(rows, id)
	if err != nil {
		return "", err
	}
	if turn == nil || turn.steering == nil {
		return "", errors.New(runtimecontrol.ChildSteerRejectedText(runtimecontrol.ChildSteerResult{Reason: runtimecontrol.SteerRejectedNoRun}))
	}
	result := turn.steering.control.SteerChild(chatSteerRuntime, turn.steering.key, id, text)
	if !result.Queued {
		return "", errors.New(runtimecontrol.ChildSteerRejectedText(result))
	}
	return chatChildSteerQueuedText(result.ChildName, result.ChildTaskID, result.ChildID), nil
}

// chatChildSteerQueuedText tells the person a message for a subagent is on its way.
func chatChildSteerQueuedText(name, taskID, workerID string) string {
	who := strings.TrimSpace(name)
	id := strings.TrimSpace(taskID)
	if id == "" {
		id = strings.TrimSpace(workerID)
	}
	switch {
	case who != "" && id != "":
		who = fmt.Sprintf("%s (%s)", who, id)
	case who == "":
		who = id
	}
	return fmt.Sprintf("Queued for %s. It takes your message at its next step; /agents %s shows when.", who, id)
}

// chatChildMessageHistory is what the person sent a turn's subagents, as the messages the next
// turns' history holds between the turn's request and its reply.
func chatChildMessageHistory(children *runtimecontrol.ChildSteering) []string {
	messages := children.Messages()
	out := make([]string, 0, len(messages))
	for _, message := range messages {
		out = append(out, chathistory.ChildMessageHistoryText(chathistory.TaskChildMessage{
			ChildID:     message.ChildID,
			ChildTaskID: message.ChildTaskID,
			ChildName:   message.ChildName,
			Text:        message.Text,
			Status:      message.Status,
			QueuedAt:    message.QueuedAt,
			Step:        message.Step,
		}))
	}
	return out
}

// steerChild handles /steer for a shared topic: the Console's runtime queues the message for the
// subagent of the topic's running task, or refuses it.
func (m *chatModel) steerChild(args string) tea.Cmd {
	id, text, err := parseSteerChildArgs(args)
	if err == nil {
		id, err = resolveSteerChildID(m.agents.snapshot(), id)
	}
	if err != nil {
		m.notice = err.Error()
		return nil
	}
	if m.id == "" {
		m.notice = runtimecontrol.ChildSteerRejectedText(runtimecontrol.ChildSteerResult{Reason: runtimecontrol.SteerRejectedNoRun})
		return nil
	}
	ctx, c, g, topicID := m.viewCtx, m.client, m.gen, m.id
	return func() tea.Msg {
		var resp daemonruntime.SubmitTaskResponse
		err := c.request(ctx, "POST", "/tasks", daemonruntime.SubmitTaskRequest{Task: text, TopicID: topicID, SteerTargetChildID: id, Trigger: chatTaskTrigger()}, &resp)
		if err != nil {
			return remoteStatus{gen: g, command: chatSteerCommand, err: err}
		}
		return remoteStatus{gen: g, command: chatSteerCommand, text: chatChildSteerQueuedText(resp.SteerTargetChildName, resp.SteerTargetChildTaskID, resp.SteerTargetChildID)}
	}
}
