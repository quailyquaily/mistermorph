package core

import (
	"context"
	"fmt"
	"log/slog"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

// GenerationSteerReplier writes replies to input steered into a channel's runs with the main
// model of the channel's current runtime generation: the model its tasks run with by default.
func GenerationSteerReplier(generations *RuntimeGenerationManager) runtimecontrol.SteerReplyFunc {
	return func(ctx context.Context, req runtimecontrol.SteerReplyRequest) (string, error) {
		lease, err := generations.Capture()
		if err != nil {
			return "", err
		}
		defer lease.Release()
		bundle := lease.Bundle()
		if bundle == nil || bundle.TaskRuntime == nil || bundle.TaskRuntime.BootstrapMainClient == nil {
			return "", fmt.Errorf("runtime generation is unavailable")
		}
		rt := bundle.TaskRuntime
		// Count the reply's usage with the run it replies about.
		ctx = llmstats.WithRunID(ctx, req.TaskID)
		return runtimecontrol.LLMSteerReplier(rt.BootstrapMainClient, rt.BootstrapMainModel)(ctx, req)
	}
}

// NewGenerationSteerResponder is the SteerResponder of a channel whose runs use generations.
func NewGenerationSteerResponder(ctx context.Context, generations *RuntimeGenerationManager, logger *slog.Logger) *runtimecontrol.SteerResponder {
	return runtimecontrol.NewSteerResponder(ctx, GenerationSteerReplier(generations), runtimecontrol.SteerResponderOptions{Logger: logger})
}

// SteerConversation is chat history as the conversation a reply to steered input is written with.
func SteerConversation(items []chathistory.ChatHistoryItem) []runtimecontrol.ConversationLine {
	lines := make([]runtimecontrol.ConversationLine, 0, len(items))
	for _, item := range items {
		text := strings.TrimSpace(item.Text)
		if text == "" {
			continue
		}
		role := "user"
		if item.Kind == chathistory.KindOutboundAgent {
			role = "assistant"
		} else if item.Kind == chathistory.KindInboundReaction {
			continue
		}
		lines = append(lines, runtimecontrol.ConversationLine{Role: role, Text: text})
	}
	return lines
}
