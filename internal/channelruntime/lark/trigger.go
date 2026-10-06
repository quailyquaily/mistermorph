package lark

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	larkbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/lark"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/grouptrigger"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/llm"
	larktools "github.com/quailyquaily/mistermorph/tools/lark"
)

type larkGroupTriggerDecision = grouptrigger.Decision

func decideLarkGroupTrigger(
	ctx context.Context,
	client llm.Client,
	model string,
	inbound larkbus.InboundMessage,
	mode string,
	addressingLLMTimeout time.Duration,
	addressingConfidenceThreshold float64,
	addressingInterjectThreshold float64,
	history []chathistory.ChatHistoryItem,
	react func(context.Context, string) error,
	personaDir ...string,
) (larkGroupTriggerDecision, bool, error) {
	explicitReason, explicitMatched := larkExplicitTriggerReason(inbound)
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
			return larkAddressingDecisionViaLLM(addrCtx, client, model, inbound, history, react != nil, personaDir...)
		},
	})
}

func larkExplicitTriggerReason(inbound larkbus.InboundMessage) (string, bool) {
	if larkMessageLooksMentioned(inbound) {
		return "mention", true
	}
	if larkCommandTriggered(inbound.Text) {
		return "command_prefix", true
	}
	return "", false
}

func larkMessageLooksMentioned(inbound larkbus.InboundMessage) bool {
	return len(inbound.MentionUsers) > 0
}

func larkCommandTriggered(text string) bool {
	text = strings.TrimSpace(text)
	return strings.HasPrefix(text, "/")
}

func larkAddressingDecisionViaLLM(
	ctx context.Context,
	client llm.Client,
	model string,
	inbound larkbus.InboundMessage,
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
	historyMessages := chathistory.BuildMessages(chathistory.ChannelLark, history)
	currentMessage := map[string]any{
		"chat_id":       strings.TrimSpace(inbound.ChatID),
		"chat_type":     strings.TrimSpace(inbound.ChatType),
		"message_id":    strings.TrimSpace(inbound.MessageID),
		"event_id":      strings.TrimSpace(inbound.EventID),
		"from_open_id":  strings.TrimSpace(inbound.FromUserID),
		"text":          strings.TrimSpace(inbound.Text),
		"mention_users": append([]string(nil), inbound.MentionUsers...),
	}
	var reactionEmojis []string
	if canReact {
		reactionEmojis = larktools.StandardReactionEmojiTypes()
	}
	systemPrompt, userPrompt, err := grouptrigger.RenderAddressingPrompts(loadLarkAddressingPersonaIdentity(personaDir...), strings.Join(reactionEmojis, ","), currentMessage, historyMessages)
	if err != nil {
		return grouptrigger.Addressing{}, false, fmt.Errorf("render addressing prompts: %w", err)
	}
	return grouptrigger.DecideViaLLM(ctx, grouptrigger.LLMDecisionOptions{
		Client:         client,
		Model:          model,
		Scene:          "lark.addressing_decision",
		SystemPrompt:   systemPrompt,
		UserPrompt:     userPrompt,
		ReactionEmojis: reactionEmojis,
	})
}

func loadLarkAddressingPersonaIdentity(personaDir ...string) string {
	spec := agent.PromptSpec{}
	promptprofile.ApplyPersonaIdentity(&spec, slog.Default(), personaDir...)
	return strings.TrimSpace(spec.Identity)
}

// runLarkLightweightPrecheck asks the decision route whether a message addressed to the bot needs
// only a reaction, and reacts when so. On PrecheckHandled it returns the Lark emoji type.
func runLarkLightweightPrecheck(
	ctx context.Context,
	generations *runtimecore.RuntimeGenerationManager,
	api *larkAPI,
	inbound larkbus.InboundMessage,
	conversationKey string,
	history map[string][]chathistory.ChatHistoryItem,
	mu *sync.Mutex,
	personaDir string,
	logger *slog.Logger,
) (runtimecore.PrecheckResult, string) {
	lease, err := generations.Capture()
	if err != nil {
		return runtimecore.PrecheckSkipped, ""
	}
	defer lease.Release()
	mu.Lock()
	historySnapshot := append([]chathistory.ChatHistoryItem(nil), history[conversationKey]...)
	mu.Unlock()
	reactTool := larktools.NewReactTool(newLarkToolAPI(api), inbound.MessageID)
	result, _ := runtimecore.RunLightweightPrecheck(llmstats.WithMetadata(ctx, larkTaskID(inbound.ChatID, inbound.MessageID), inbound.EventID), lease.Bundle(), runtimecore.LightweightPrecheckRequest{
		Scene:      "lark.lightweight_decision",
		PersonaDir: personaDir,
		CurrentMessage: map[string]any{
			"chat_id":       strings.TrimSpace(inbound.ChatID),
			"chat_type":     strings.TrimSpace(inbound.ChatType),
			"message_id":    strings.TrimSpace(inbound.MessageID),
			"from_open_id":  strings.TrimSpace(inbound.FromUserID),
			"text":          strings.TrimSpace(inbound.Text),
			"mention_users": append([]string(nil), inbound.MentionUsers...),
		},
		History: chathistory.BuildMessages(chathistory.ChannelLark, historySnapshot),
		Emojis:  larktools.StandardReactionEmojiTypes(),
		Logger:  logger,
		Deliver: func(ctx context.Context, emojiType string) error {
			_, err := reactTool.Execute(ctx, map[string]any{"emoji_type": emojiType})
			return err
		},
	})
	if result != runtimecore.PrecheckHandled {
		return result, ""
	}
	emojiType := ""
	if reaction := reactTool.LastReaction(); reaction != nil {
		emojiType = reaction.EmojiType
	}
	return result, emojiType
}
