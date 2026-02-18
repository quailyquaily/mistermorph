package telegram

import (
	"context"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/grouptrigger"
	"github.com/quailyquaily/mistermorph/llm"
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
// It must not decide output modality (text reply vs reaction), which is handled in the generation layer.
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
		Addressing: func(addrCtx context.Context) (grouptrigger.Addressing, bool, error) {
			return addressingDecisionViaLLM(addrCtx, client, model, msg, text, history)
		},
	})
}

func groupExplicitMentionReason(msg *telegramMessage, text string, botUser string, botID int64) (string, bool) {
	// Reply-to-bot.
	if msg != nil && msg.ReplyTo != nil && msg.ReplyTo.From != nil && msg.ReplyTo.From.ID == botID {
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
	if msg.ReplyTo.From != nil && msg.ReplyTo.From.ID == botID {
		return false
	}
	_, bodyMentioned := groupBodyMentionReason(msg, text, botUser, botID)
	return !bodyMentioned
}
