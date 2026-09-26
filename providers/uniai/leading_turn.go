package uniai

import (
	"strings"

	"github.com/quailyquaily/mistermorph/llm"
)

// leadingUserTurnText opens a conversation whose history starts with one of the agent's own
// replies, e.g. when the history window begins at a reply or the agent wrote first.
const leadingUserTurnText = "(earlier conversation)"

// ensureLeadingUserTurn puts a user turn before a leading assistant message for providers
// that take the Anthropic message format: Bedrock documents that Claude messages must start
// with the user role. Other providers accept the history as it is.
func ensureLeadingUserTurn(req llm.Request, provider string) llm.Request {
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "anthropic", "bedrock":
	default:
		return req
	}
	for i, message := range req.Messages {
		role := strings.ToLower(strings.TrimSpace(message.Role))
		if role == "system" {
			continue
		}
		if role != "assistant" {
			return req
		}
		messages := make([]llm.Message, 0, len(req.Messages)+1)
		messages = append(messages, req.Messages[:i]...)
		messages = append(messages, llm.Message{Role: "user", Content: leadingUserTurnText})
		messages = append(messages, req.Messages[i:]...)
		req.Messages = messages
		return req
	}
	return req
}
