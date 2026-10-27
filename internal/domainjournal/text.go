package domainjournal

import (
	"encoding/json"
	"strings"
	"unicode/utf8"
)

// maxSearchTextBytes bounds the text one event adds to the full-text index.
const maxSearchTextBytes = 16 << 10

// searchText is what an event adds to the full-text index: what people said, each piece once. A
// task's text comes from its upsert and its final output from the update that ends it, so the many
// snapshots of a running task add nothing. Traces and tool output are never indexed.
func searchText(event Event) string {
	var text string
	switch event.Domain + "/" + event.Type {
	case "task/task_upsert":
		var payload struct {
			Task *struct {
				Task string `json:"task"`
			} `json:"task"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil && payload.Task != nil {
			text = payload.Task.Task
		}
	case "task/task_update":
		var payload struct {
			Task *struct {
				Status string `json:"status"`
				Result *struct {
					Final *struct {
						Output json.RawMessage `json:"output"`
					} `json:"final"`
				} `json:"result"`
			} `json:"task"`
		}
		if json.Unmarshal(event.Payload, &payload) != nil || payload.Task == nil {
			return ""
		}
		switch payload.Task.Status {
		case "done", "failed", "canceled":
		default:
			return ""
		}
		if payload.Task.Result != nil && payload.Task.Result.Final != nil {
			text = outputText(payload.Task.Result.Final.Output)
		}
	case "conversation/untriggered_inbound":
		var payload struct {
			Text string `json:"text"`
		}
		if json.Unmarshal(event.Payload, &payload) == nil {
			text = payload.Text
		}
	}
	return truncateText(strings.TrimSpace(text), maxSearchTextBytes)
}

// outputText is a final output as text: the string itself, or the JSON of a structured output.
func outputText(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	return string(raw)
}

func truncateText(text string, max int) string {
	if len(text) <= max {
		return text
	}
	text = text[:max]
	for len(text) > 0 && !utf8.ValidString(text) {
		text = text[:len(text)-1]
	}
	return text
}
