package telegram

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/grouptrigger"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/promptprofile"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	telegramtools "github.com/quailyquaily/mistermorph/tools/telegram"
)

type telegramGroupTriggerDecision = grouptrigger.Decision

func quoteReplyMessageIDForGroupTrigger(msg *telegramMessage, dec telegramGroupTriggerDecision) int64 {
	if msg == nil || msg.MessageID <= 0 {
		return 0
	}
	if dec.Addressing.Impulse > 0.8 {
		return msg.MessageID
	}
	return 0
}

// groupTriggerDecision belongs to the trigger layer.
// It decides whether this group message should enter an agent run.
// An accepted lightweight decision sends a reaction without starting an agent run.
func groupTriggerDecision(
	ctx context.Context,
	client llm.Client,
	model string,
	msg *telegramMessage,
	botUser string,
	botID int64,
	mode string,
	addressingLLMTimeout time.Duration,
	addressingConfidenceThreshold float64,
	addressingInterjectThreshold float64,
	history []chathistory.ChatHistoryItem,
	addressingReactionTool tools.Tool,
	personaDir ...string,
) (telegramGroupTriggerDecision, bool, error) {
	if msg == nil {
		return telegramGroupTriggerDecision{}, false, nil
	}
	text := strings.TrimSpace(messageTextOrCaption(msg))
	explicitReason, explicitMentioned := groupExplicitMentionReason(msg, text, botUser, botID)
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
			return addressingDecisionViaLLM(addrCtx, client, model, msg, text, history, addressingReactionTool, personaDir...)
		},
	})
}

func groupExplicitMentionReason(msg *telegramMessage, text string, botUser string, botID int64) (string, bool) {
	// Reply-to-bot.
	if msg != nil && msg.ReplyTo != nil && !isTelegramForumTopicRootMessage(msg.ReplyTo) && msg.ReplyTo.From != nil && msg.ReplyTo.From.ID == botID {
		if text == "" && !messageHasDownloadableFile(msg) {
			return "", false
		}
		return "reply", true
	}
	return groupBodyMentionReason(msg, text, botUser, botID)
}

func groupBodyMentionReason(msg *telegramMessage, text string, botUser string, botID int64) (string, bool) {
	text = strings.TrimSpace(text)
	if text == "" {
		return "", false
	}

	// Entity-based mention of the bot (text_mention includes user id; mention includes "@username").
	if msg != nil {
		entities := msg.Entities
		if strings.TrimSpace(msg.Text) == "" && strings.TrimSpace(msg.Caption) != "" {
			entities = msg.CaptionEntities
		}
		for _, e := range entities {
			switch strings.ToLower(strings.TrimSpace(e.Type)) {
			case "text_mention":
				if e.User != nil && e.User.ID == botID {
					return "text_mention", true
				}
			case "mention":
				if botUser != "" {
					mention := sliceByUTF16(text, e.Offset, e.Length)
					if strings.EqualFold(mention, "@"+botUser) {
						return "mention_entity", true
					}
				}
			}
		}
	}

	// Fallback explicit @mention (some clients may omit entities).
	if botUser != "" && strings.Contains(strings.ToLower(text), "@"+strings.ToLower(botUser)) {
		return "at_mention", true
	}
	return "", false
}

func shouldSkipGroupReplyWithoutBodyMention(msg *telegramMessage, text string, botUser string, botID int64) bool {
	if msg == nil {
		return false
	}
	if msg.From != nil && msg.From.IsBot {
		return false
	}
	if msg.ReplyTo == nil {
		return false
	}
	if isTelegramForumTopicRootMessage(msg.ReplyTo) {
		return false
	}
	if msg.ReplyTo.From != nil && msg.ReplyTo.From.ID == botID {
		return false
	}
	_, bodyMentioned := groupBodyMentionReason(msg, text, botUser, botID)
	return !bodyMentioned
}

func addressingDecisionViaLLM(
	ctx context.Context,
	client llm.Client,
	model string,
	msg *telegramMessage,
	text string,
	history []chathistory.ChatHistoryItem,
	addressingTool tools.Tool,
	personaDir ...string,
) (grouptrigger.Addressing, bool, error) {
	if ctx == nil || client == nil {
		return grouptrigger.Addressing{}, false, nil
	}
	text = strings.TrimSpace(text)
	model = strings.TrimSpace(model)
	if model == "" {
		return grouptrigger.Addressing{}, false, fmt.Errorf("missing model for addressing_llm")
	}

	historyMessages := chathistory.BuildMessages(chathistory.ChannelTelegram, history)
	currentMessage := map[string]any{
		"text":   text,
		"sender": map[string]any{},
	}
	sender := currentMessage["sender"].(map[string]any)
	if msg != nil && msg.From != nil {
		sender["id"] = msg.From.ID
		sender["is_bot"] = msg.From.IsBot
		sender["username"] = strings.TrimSpace(msg.From.Username)
		sender["display_name"] = strings.TrimSpace(telegramDisplayName(msg.From))
	}
	if msg != nil && msg.Chat != nil {
		sender["chat_id"] = msg.Chat.ID
		sender["chat_type"] = strings.TrimSpace(msg.Chat.Type)
	}
	sys, user, err := grouptrigger.RenderAddressingPrompts(loadAddressingPersonaIdentity(personaDir...), strings.Join(telegramtools.StandardReactionEmojis(), ","), currentMessage, historyMessages)
	if err != nil {
		return grouptrigger.Addressing{}, false, fmt.Errorf("render addressing prompts: %w", err)
	}
	var reactionEmojis []string
	if addressingTool != nil {
		reactionEmojis = telegramtools.StandardReactionEmojis()
	}
	return grouptrigger.DecideViaLLM(ctx, grouptrigger.LLMDecisionOptions{
		Client:         client,
		Model:          model,
		Scene:          "telegram.addressing_decision",
		SystemPrompt:   sys,
		UserPrompt:     user,
		ReactionEmojis: reactionEmojis,
	})
}

var silentPromptProfileLogger = slog.New(slog.NewTextHandler(io.Discard, nil))

func loadAddressingPersonaIdentity(personaDir ...string) string {
	spec := agent.PromptSpec{}
	promptprofile.ApplyPersonaIdentity(&spec, silentPromptProfileLogger, personaDir...)
	persona := strings.TrimSpace(spec.Identity)
	if persona == "" {
		return ""
	}
	return persona
}

// runLightweightPrecheck asks the decision route whether a message addressed to the bot needs
// only a reaction, and reacts when so.
func (s *telegramRuntimeState) runLightweightPrecheck(msg *telegramMessage, text string, conversationKey string) (runtimecore.PrecheckResult, string) {
	if msg == nil || msg.Chat == nil || s.api == nil || msg.MessageID <= 0 {
		return runtimecore.PrecheckSkipped, ""
	}
	generationLease, runtimeBundle, err := s.captureRuntimeGeneration()
	if err != nil {
		return runtimecore.PrecheckSkipped, ""
	}
	defer func() {
		if generationLease != nil {
			generationLease.Release()
		}
	}()
	s.stateMu.Lock()
	history := append([]chathistory.ChatHistoryItem(nil), s.history[conversationKey]...)
	s.stateMu.Unlock()
	currentMessage := map[string]any{"text": strings.TrimSpace(text)}
	sender := map[string]any{"chat_id": msg.Chat.ID, "chat_type": strings.TrimSpace(msg.Chat.Type)}
	if msg.From != nil {
		sender["id"] = msg.From.ID
		sender["is_bot"] = msg.From.IsBot
		sender["username"] = strings.TrimSpace(msg.From.Username)
		sender["display_name"] = strings.TrimSpace(telegramDisplayName(msg.From))
	}
	currentMessage["sender"] = sender
	chatID := msg.Chat.ID
	ctx := llmstats.WithRunID(context.Background(), telegramTaskID(chatID, msg.MessageThreadID, msg.MessageID))
	return runtimecore.RunLightweightPrecheck(ctx, runtimeBundle, runtimecore.LightweightPrecheckRequest{
		Scene:          "telegram.lightweight_decision",
		PersonaDir:     s.dependencies.RuntimePaths.PersonaDir,
		CurrentMessage: currentMessage,
		History:        chathistory.BuildMessages(chathistory.ChannelTelegram, history),
		Emojis:         telegramtools.StandardReactionEmojis(),
		Logger:         s.logger,
		Deliver: func(ctx context.Context, emoji string) error {
			tool := telegramtools.NewReactTool(newTelegramToolAPI(s.api), chatID, msg.MessageID, s.allowedChatIDs)
			_, err := tool.Execute(ctx, map[string]any{"emoji": emoji})
			return err
		},
	})
}
