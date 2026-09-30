package chatcmd

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/clifmt"
)

// formatRawChatOutput returns the raw assistant output without any terminal
// formatting or ANSI codes. It is intended for use in LLM history.
func formatRawChatOutput(final *agent.Final) string {
	if final == nil {
		return ""
	}
	switch output := final.Output.(type) {
	case string:
		return strings.TrimSpace(output)
	case nil:
		payload, _ := json.MarshalIndent(final, "", "  ")
		return strings.TrimSpace(string(payload))
	default:
		payload, err := json.MarshalIndent(output, "", "  ")
		if err != nil {
			return strings.TrimSpace(fmt.Sprint(output))
		}
		return strings.TrimSpace(string(payload))
	}
}

// formatChatOutput returns the terminal-rendered version of the assistant
// output, including Markdown/ANSI formatting for display.
func formatChatOutput(final *agent.Final) string {
	if final == nil {
		return ""
	}
	switch output := final.Output.(type) {
	case string:
		return clifmt.RenderMarkdown(strings.TrimSpace(output))
	case nil:
		payload, _ := json.MarshalIndent(final, "", "  ")
		return strings.TrimSpace(string(payload))
	default:
		payload, err := json.MarshalIndent(output, "", "  ")
		if err != nil {
			return strings.TrimSpace(fmt.Sprint(output))
		}
		return strings.TrimSpace(string(payload))
	}
}

// formatChatStepMessage renders a finished plan step's note like the agent's reply.
func formatChatStepMessage(note string) string {
	return clifmt.RenderMarkdown(strings.TrimSpace(note))
}

// formatRawChatHistoryOutput is the assistant turn as the model sees it later: the messages sent
// as plan steps finished, then the reply.
func formatRawChatHistoryOutput(final *agent.Final) string {
	reply := formatRawChatOutput(final)
	if final == nil {
		return reply
	}
	parts := agent.PlanNotes(final.Plan)
	if reply != "" {
		parts = append(parts, reply)
	}
	return strings.Join(parts, "\n\n")
}
