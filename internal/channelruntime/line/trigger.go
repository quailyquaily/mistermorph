package line

import (
	"context"
	"fmt"
	"strings"
	"time"

	linebus "github.com/quailyquaily/mistermorph/internal/bus/adapters/line"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/grouptrigger"
	"github.com/quailyquaily/mistermorph/llm"
)

type lineGroupTriggerDecision = grouptrigger.Decision

func decideLineGroupTrigger(
	ctx context.Context,
	client llm.Client,
	model string,
	inbound linebus.InboundMessage,
	botUserID string,
	mode string,
	addressingLLMTimeout time.Duration,
	addressingConfidenceThreshold float64,
	addressingInterjectThreshold float64,
	history []chathistory.ChatHistoryItem,
	react func(context.Context, string) error,
	personaDir ...string,
) (lineGroupTriggerDecision, bool, error) {
	explicitReason, explicitMatched := lineExplicitTriggerReason(inbound, botUserID)
	return grouptrigger.Decide(ctx, grouptrigger.DecideOptions{
		Mode:                     mode,
		ConfidenceThreshold:      addressingConfidenceThreshold,
		InterjectThreshold:       addressingInterjectThreshold,
		ExplicitReason:           explicitReason,
		ExplicitMatched:          explicitMatched,
		AddressingFallbackReason: mode,
		AddressingTimeout:        addressingLLMTimeout,
		React:                    react,
		Addressing: func(addrCtx context.Context) (grouptrigger.Addressing, bool, error) {
			return lineAddressingDecisionViaLLM(addrCtx, client, model, inbound, history, react != nil, personaDir...)
		},
	})
}

func lineExplicitTriggerReason(inbound linebus.InboundMessage, botUserID string) (string, bool) {
	if lineMessageMentionsBot(inbound, botUserID) {
		return "mention", true
	}
	if lineCommandTriggered(inbound.Text) {
		return "command_prefix", true
	}
	return "", false
}

func lineMessageMentionsBot(inbound linebus.InboundMessage, botUserID string) bool {
	botUserID = strings.TrimSpace(botUserID)
	if botUserID == "" {
		return false
	}
	for _, raw := range inbound.MentionUsers {
		if strings.TrimSpace(raw) == botUserID {
			return true
		}
	}
	return false
}

func lineCommandTriggered(text string) bool {
	text = strings.TrimSpace(text)
	return strings.HasPrefix(text, "/")
}

func lineAddressingDecisionViaLLM(
	ctx context.Context,
	client llm.Client,
	model string,
	inbound linebus.InboundMessage,
	history []chathistory.ChatHistoryItem,
	canReact bool,
	personaDir ...string,
) (grouptrigger.Addressing, bool, error) {
	if ctx == nil || client == nil {
		return grouptrigger.Addressing{}, false, nil
	}
	model = strings.TrimSpace(model)
	if model == "" {
		return grouptrigger.Addressing{}, false, fmt.Errorf("missing model for addressing_llm")
	}
	historyMessages := chathistory.BuildMessages(chathistory.ChannelLine, history)
	currentMessage := map[string]any{
		"chat_id":       strings.TrimSpace(inbound.ChatID),
		"chat_type":     strings.TrimSpace(inbound.ChatType),
		"message_id":    strings.TrimSpace(inbound.MessageID),
		"event_id":      strings.TrimSpace(inbound.EventID),
		"from_user_id":  strings.TrimSpace(inbound.FromUserID),
		"text":          strings.TrimSpace(inbound.Text),
		"mention_users": append([]string(nil), inbound.MentionUsers...),
	}
	// LINE has no reactions; a chosen emoji is sent as a message.
	var reactionEmojis []string
	if canReact {
		reactionEmojis = grouptrigger.DefaultLightweightEmojis
	}
	systemPrompt, userPrompt, err := grouptrigger.RenderAddressingPrompts(runtimecore.PersonaIdentity(personaDir...), strings.Join(reactionEmojis, ","), currentMessage, historyMessages)
	if err != nil {
		return grouptrigger.Addressing{}, false, fmt.Errorf("render addressing prompts: %w", err)
	}
	return grouptrigger.DecideViaLLM(ctx, grouptrigger.LLMDecisionOptions{
		Client:         client,
		Model:          model,
		Scene:          "line.addressing_decision",
		SystemPrompt:   systemPrompt,
		UserPrompt:     userPrompt,
		ReactionEmojis: reactionEmojis,
	})
}
