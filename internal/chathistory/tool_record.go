package chathistory

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

// The reply is all a later turn sees of an earlier one, so a result the reply left out was lost,
// and the agent, seeing no call, could say it had made none. The record gives the calls back in
// short: enough to answer from, not the outputs in full.
const (
	// toolRecordMaxCalls and toolRecordMaxBytes bound what a record lists: the last calls, nearest
	// the reply, as many as fit (the last one always). A topic's window holds six turns, and once
	// it slides its history is sent uncached each turn, so a record has to stay small.
	toolRecordMaxCalls = 8
	toolRecordMaxBytes = 2400
	// toolRecordArgsMax and toolRecordResultMax bound one call's arguments and result, in bytes.
	toolRecordArgsMax   = 300
	toolRecordResultMax = 800
	// toolRecordResultTail is how much of a cut result is kept from its end, where a command's
	// last lines and a worker's answer are.
	toolRecordResultTail = 300

	toolRecordIntro = "Record of the tool calls you made in this turn, with their results trimmed. It is not a message from the user."
)

// TaskToolRecord is the record of the tool calls a finished task made, read from the trace its
// result keeps (the tool_done events of the agent's own calls, with the result it was given).
// A task that still runs has none: its trace grows, and a history message must not change once
// it has been sent, or the provider's prompt cache misses from there on.
func TaskToolRecord(task taskdomain.TaskInfo) (ChatHistoryItem, bool) {
	if task.FinishedAt == nil || task.FinishedAt.IsZero() {
		return ChatHistoryItem{}, false
	}
	text := toolRecordText(task.Result)
	if text == "" {
		return ChatHistoryItem{}, false
	}
	return ChatHistoryItem{
		Channel:          "console",
		Kind:             KindToolRecord,
		ChatID:           "console:" + task.TopicID,
		ChatType:         "private",
		MessageID:        strings.TrimSpace(task.ID) + ":tools",
		ReplyToMessageID: strings.TrimSpace(task.ID),
		SentAt:           taskOutboundSentAt(task),
		Sender: ChatHistorySender{
			UserID:     "0",
			Username:   "system",
			Nickname:   "Tool record",
			DisplayRef: "system",
		},
		Text: text,
	}, true
}

func toolRecordText(result any) string {
	if result == nil {
		return ""
	}
	data, err := json.Marshal(result)
	if err != nil {
		return ""
	}
	var decoded struct {
		Trace struct {
			Entries []struct {
				Event struct {
					Kind     string         `json:"kind"`
					Parent   string         `json:"parent_activity_id"`
					ToolName string         `json:"tool_name"`
					Status   string         `json:"status"`
					Text     string         `json:"text"`
					Error    string         `json:"error"`
					Args     map[string]any `json:"args"`
				} `json:"event"`
			} `json:"entries"`
		} `json:"trace"`
	}
	if json.Unmarshal(data, &decoded) != nil {
		return ""
	}
	var calls []string
	for _, entry := range decoded.Trace.Entries {
		event := entry.Event
		// The agent's own calls: a call a codemode script made is part of that call's result.
		if event.Kind != "tool_done" || event.Parent != "" || strings.TrimSpace(event.ToolName) == "" {
			continue
		}
		var b strings.Builder
		b.WriteString(strings.TrimSpace(event.ToolName))
		if len(event.Args) > 0 {
			// Map keys are written in order, so the same call always gives the same text.
			if args, err := json.Marshal(event.Args); err == nil {
				b.WriteString(" " + cutMiddle(string(args), toolRecordArgsMax, 0))
			}
		}
		if failure := strings.TrimSpace(event.Error); failure != "" {
			b.WriteString("\nfailed: " + cutMiddle(failure, toolRecordArgsMax, 0))
		}
		if output := strings.TrimSpace(event.Text); output != "" {
			b.WriteString("\nresult: " + cutMiddle(output, toolRecordResultMax, toolRecordResultTail))
		}
		calls = append(calls, b.String())
	}
	if len(calls) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString(toolRecordIntro)
	first, size := len(calls)-1, len(calls[len(calls)-1])
	for first > 0 && len(calls)-first < toolRecordMaxCalls && size+len(calls[first-1]) <= toolRecordMaxBytes {
		first--
		size += len(calls[first])
	}
	if first > 0 {
		fmt.Fprintf(&b, "\n\n(%d earlier calls are not listed.)", first)
	}
	for i := first; i < len(calls); i++ {
		fmt.Fprintf(&b, "\n\n%d. %s", i+1, calls[i])
	}
	return b.String()
}

// cutMiddle keeps text within max bytes: its start and, with tail, that much of its end, around
// a note of how much was left out. Cuts fall between characters.
func cutMiddle(text string, max, tail int) string {
	if len(text) <= max {
		return text
	}
	head := max - tail
	for head > 0 && !utf8.RuneStart(text[head]) {
		head--
	}
	end := len(text) - tail
	for end < len(text) && !utf8.RuneStart(text[end]) {
		end++
	}
	return fmt.Sprintf("%s … (%d bytes left out) … %s", text[:head], end-head, text[end:])
}
