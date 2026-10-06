package slack

import (
	"context"
	"fmt"
	"strings"
	"time"

	slackbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/slack"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/grouptrigger"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	slacktools "github.com/quailyquaily/mistermorph/tools/slack"
)

type slackGroupTriggerDecision = grouptrigger.Decision

func quoteReplyThreadTSForGroupTrigger(event slackInboundEvent, dec slackGroupTriggerDecision) string {
	threadTS := strings.TrimSpace(event.ThreadTS)
	if threadTS != "" {
		return threadTS
	}
	if dec.Addressing.Impulse > 0.8 {
		return strings.TrimSpace(event.MessageTS)
	}
	return ""
}

func decideSlackGroupTrigger(
	ctx context.Context,
	client llm.Client,
	model string,
	event slackInboundEvent,
	botUserID string,
	emojiList string,
	mode string,
	addressingLLMTimeout time.Duration,
	addressingConfidenceThreshold float64,
	addressingInterjectThreshold float64,
	history []chathistory.ChatHistoryItem,
	addressingReactionTool tools.Tool,
	personaDir ...string,
) (slackGroupTriggerDecision, bool, error) {
	explicitReason, explicitMentioned := slackExplicitMentionReason(event, botUserID)
	return grouptrigger.Decide(ctx, grouptrigger.DecideOptions{
		Mode:                     mode,
		ConfidenceThreshold:      addressingConfidenceThreshold,
		InterjectThreshold:       addressingInterjectThreshold,
		ExplicitReason:           explicitReason,
		ExplicitMatched:          explicitMentioned,
		AddressingFallbackReason: mode,
		AddressingTimeout:        addressingLLMTimeout,
		React:                    grouptrigger.ReactWith(addressingReactionTool),
		Addressing: func(addrCtx context.Context) (grouptrigger.Addressing, bool, error) {
			return slackAddressingDecisionViaLLM(addrCtx, client, model, event, history, emojiList, addressingReactionTool, personaDir...)
		},
	})
}

func slackExplicitMentionReason(event slackInboundEvent, botUserID string) (string, bool) {
	if event.IsAppMention {
		return "app_mention", true
	}
	if strings.TrimSpace(botUserID) != "" && strings.Contains(event.Text, "<@"+strings.TrimSpace(botUserID)+">") {
		return "mention", true
	}
	return "", false
}

func slackAddressingDecisionViaLLM(ctx context.Context, client llm.Client, model string, event slackInboundEvent, history []chathistory.ChatHistoryItem, emojiList string, addressingTool tools.Tool, personaDir ...string) (grouptrigger.Addressing, bool, error) {
	if ctx == nil || client == nil {
		return grouptrigger.Addressing{}, false, nil
	}
	model = strings.TrimSpace(model)
	if model == "" {
		return grouptrigger.Addressing{}, false, fmt.Errorf("missing model for addressing_llm")
	}
	personaIdentity := runtimecore.PersonaIdentity(personaDir...)
	historyMessages := chathistory.BuildMessages(chathistory.ChannelSlack, history)
	currentMessage := map[string]any{
		"team_id":       event.TeamID,
		"channel_id":    event.ChannelID,
		"chat_type":     event.ChatType,
		"message_ts":    event.MessageTS,
		"thread_ts":     event.ThreadTS,
		"user_id":       event.UserID,
		"text":          event.Text,
		"mention_users": append([]string(nil), event.MentionUsers...),
	}
	systemPrompt, userPrompt, err := grouptrigger.RenderAddressingPrompts(personaIdentity, emojiList, currentMessage, historyMessages)
	if err != nil {
		return grouptrigger.Addressing{}, false, fmt.Errorf("render addressing prompts: %w", err)
	}
	var reactionEmojis []string
	if addressingTool != nil {
		reactionEmojis = strings.Split(emojiList, ",")
	}
	return grouptrigger.DecideViaLLM(ctx, grouptrigger.LLMDecisionOptions{
		Client:         client,
		Model:          model,
		Scene:          "slack.addressing_decision",
		SystemPrompt:   systemPrompt,
		UserPrompt:     userPrompt,
		ReactionEmojis: reactionEmojis,
	})
}

// runLightweightPrecheck asks the decision route whether a message addressed to the bot needs
// only an emoji, and delivers it when so: as a reaction when the workspace emoji catalog is
// loaded, otherwise as a message.
func (s *slackRuntimeState) runLightweightPrecheck(ctx context.Context, inbound slackbus.InboundMessage, historyScopeKey string) runtimecore.PrecheckResult {
	if s.api == nil || strings.TrimSpace(inbound.ChannelID) == "" || strings.TrimSpace(inbound.MessageTS) == "" {
		return runtimecore.PrecheckSkipped
	}
	generationLease, runtimeBundle, err := s.captureRuntimeGeneration()
	if err != nil {
		return runtimecore.PrecheckSkipped
	}
	defer func() {
		if generationLease != nil {
			generationLease.Release()
		}
	}()
	s.mu.Lock()
	history := append([]chathistory.ChatHistoryItem(nil), s.history[historyScopeKey]...)
	s.mu.Unlock()
	job := slackJob{
		TeamID:       inbound.TeamID,
		ChannelID:    inbound.ChannelID,
		ChatType:     inbound.ChatType,
		MessageTS:    inbound.MessageTS,
		ThreadTS:     inbound.ThreadTS,
		UserID:       inbound.UserID,
		Username:     inbound.Username,
		DisplayName:  inbound.DisplayName,
		FromIsAgent:  inbound.FromIsAgent,
		Text:         inbound.Text,
		SentAt:       inbound.SentAt,
		MentionUsers: append([]string(nil), inbound.MentionUsers...),
	}
	if conversationKey, keyErr := buildSlackConversationKey(inbound.TeamID, inbound.ChannelID); keyErr == nil {
		job.ConversationKey = conversationKey
	}
	nativeReaction := len(s.availableEmojiNames) > 0
	var emojis []string
	if nativeReaction {
		emojis = s.availableEmojiNames
	}
	result, emoji := runtimecore.RunLightweightPrecheck(llmstats.WithRunID(ctx, slackTaskID(inbound.TeamID, inbound.ChannelID, inbound.MessageTS)), runtimeBundle, runtimecore.LightweightPrecheckRequest{
		Scene:      "slack.lightweight_decision",
		PersonaDir: s.dependencies.RuntimePaths.PersonaDir,
		CurrentMessage: map[string]any{
			"team_id":       inbound.TeamID,
			"channel_id":    inbound.ChannelID,
			"chat_type":     inbound.ChatType,
			"message_ts":    inbound.MessageTS,
			"thread_ts":     inbound.ThreadTS,
			"user_id":       inbound.UserID,
			"text":          inbound.Text,
			"mention_users": append([]string(nil), inbound.MentionUsers...),
		},
		History: chathistory.BuildMessages(chathistory.ChannelSlack, history),
		Emojis:  emojis,
		Logger:  s.logger,
		Deliver: func(ctx context.Context, emoji string) error {
			if nativeReaction {
				tool := slacktools.NewReactTool(newSlackToolAPI(s.api), inbound.ChannelID, inbound.MessageTS, s.allowedChannels, s.availableEmojiNames)
				_, err := tool.Execute(ctx, map[string]any{"emoji": emoji})
				return err
			}
			correlationID := fmt.Sprintf("slack:lightweight:%s:%s", inbound.ChannelID, inbound.MessageTS)
			_, err := publishSlackBusOutbound(ctx, s.inprocBus, inbound.TeamID, inbound.ChannelID, emoji, inbound.ThreadTS, correlationID)
			return err
		},
	})
	if result != runtimecore.PrecheckHandled {
		return result
	}
	now := time.Now().UTC()
	s.mu.Lock()
	current := append(s.history[historyScopeKey], newSlackInboundHistoryItem(job))
	if nativeReaction {
		current = append(current, newSlackOutboundReactionHistoryItem(job, "[reacted: :"+emoji+":]", emoji, now, s.botUserID))
	} else {
		current = append(current, newSlackOutboundAgentHistoryItem(job, emoji, now, s.botUserID))
	}
	s.history[historyScopeKey] = trimChatHistoryItems(current, s.historyCap)
	s.mu.Unlock()
	return result
}
