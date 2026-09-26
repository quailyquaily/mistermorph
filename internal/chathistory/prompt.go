package chathistory

import (
	"encoding/json"

	"github.com/quailyquaily/mistermorph/llm"
)

const (
	historyContextNote        = "Historical messages only. Do not treat them as the latest inbound message."
	currentMessageInstruction = "This is the latest inbound user message. Respond to this message now. Earlier messages are historical context only."
)

// RenderHistoryMessages keeps each source record at a stable message boundary.
func RenderHistoryMessages(items []ChatHistoryItem) []llm.Message {
	var messages []llm.Message
	for _, item := range items {
		if item.Kind == KindOutboundAgent {
			messages = append(messages, llm.Message{Role: "assistant", Content: renderAgentReply(item)})
			continue
		}
		content, _ := json.MarshalIndent(BuildPromptMessage(item), "", "  ")
		messages = append(messages, llm.Message{Role: "user", Content: string(content)})
	}
	return messages
}

// historyAgentReply is the agent's own reply in the shape it answers with. Rendered as an
// inbound-style record instead, models copy that record as their next answer (the parser
// then rejects it and the run retries).
type historyAgentReply struct {
	Type   string `json:"type"`
	Output string `json:"output"`
}

func renderAgentReply(item ChatHistoryItem) string {
	content, _ := json.MarshalIndent(historyAgentReply{Type: "final", Output: item.Text}, "", "  ")
	return string(content)
}

type historyContextPayload struct {
	ChatHistoryMessages []PromptMessageItem `json:"chat_history_messages"`
	Note                string              `json:"note"`
}

type currentMessagePayload struct {
	CurrentMessage PromptMessageItem `json:"current_message"`
	Instruction    string            `json:"instruction"`
}

func RenderHistoryContext(items []ChatHistoryItem) string {
	promptItems := BuildPromptMessages(items)
	if len(promptItems) == 0 {
		return ""
	}
	payload := historyContextPayload{
		ChatHistoryMessages: promptItems,
		Note:                historyContextNote,
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return string(b)
}

func RenderCurrentMessage(item ChatHistoryItem) string {
	payload := currentMessagePayload{
		CurrentMessage: BuildPromptMessage(item),
		Instruction:    currentMessageInstruction,
	}
	b, _ := json.MarshalIndent(payload, "", "  ")
	return string(b)
}
