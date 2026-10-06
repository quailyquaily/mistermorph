package discord

import (
	"context"
	"fmt"
	"strings"
	"time"

	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
	runtimecore "github.com/quailyquaily/mistermorph/internal/channelruntime/core"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/grouptrigger"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// discordReactionEmojis are the reactions the addressing model may choose for a lightweight answer.
const discordReactionEmojis = "👍,👀,❤️,😂,🎉,🙏,✅,🤔"

type discordTriggerOptions struct {
	Mode                string
	ConfidenceThreshold float64
	InterjectThreshold  float64
	Timeout             time.Duration
	Client              llm.Client
	Model               string
	PersonaDir          string
}

// decideDiscordGroupTrigger decides whether a server message starts a run. A mention of the bot or a
// reply to it always does; in strict mode nothing else does, and smart and talkative ask the
// addressing model.
func decideDiscordGroupTrigger(ctx context.Context, opts discordTriggerOptions, inbound discordbus.InboundMessage, botID string, history []chathistory.ChatHistoryItem, reactionTool tools.Tool) (grouptrigger.Decision, bool, error) {
	addressed := discordAddressed(inbound, botID)
	if opts.Mode == groupTriggerStrict {
		if addressed {
			return grouptrigger.Decision{Reason: "mention", Addressing: grouptrigger.Addressing{Impulse: 1}}, true, nil
		}
		return grouptrigger.Decision{Reason: "strict"}, false, nil
	}
	return grouptrigger.Decide(ctx, grouptrigger.DecideOptions{
		Mode:                     opts.Mode,
		ConfidenceThreshold:      opts.ConfidenceThreshold,
		InterjectThreshold:       opts.InterjectThreshold,
		ExplicitReason:           "mention",
		ExplicitMatched:          addressed,
		AddressingFallbackReason: opts.Mode,
		AddressingTimeout:        opts.Timeout,
		React:                    grouptrigger.ReactWith(reactionTool),
		Addressing: func(addrCtx context.Context) (grouptrigger.Addressing, bool, error) {
			return discordAddressingDecisionViaLLM(addrCtx, opts, inbound, history, reactionTool)
		},
	})
}

func discordAddressingDecisionViaLLM(ctx context.Context, opts discordTriggerOptions, inbound discordbus.InboundMessage, history []chathistory.ChatHistoryItem, reactionTool tools.Tool) (grouptrigger.Addressing, bool, error) {
	if ctx == nil || opts.Client == nil {
		return grouptrigger.Addressing{}, false, nil
	}
	model := strings.TrimSpace(opts.Model)
	if model == "" {
		return grouptrigger.Addressing{}, false, fmt.Errorf("missing model for addressing_llm")
	}
	currentMessage := map[string]any{
		"guild_id":      inbound.GuildID,
		"channel_id":    inbound.ChannelID,
		"chat_type":     inbound.ChatType,
		"message_id":    inbound.MessageID,
		"user_id":       inbound.UserID,
		"text":          inbound.Text,
		"mention_users": append([]string(nil), inbound.MentionUserIDs...),
	}
	systemPrompt, userPrompt, err := grouptrigger.RenderAddressingPrompts(runtimecore.PersonaIdentity(opts.PersonaDir), discordReactionEmojis, currentMessage, chathistory.BuildMessages(chathistory.ChannelDiscord, history))
	if err != nil {
		return grouptrigger.Addressing{}, false, fmt.Errorf("render addressing prompts: %w", err)
	}
	var reactionEmojis []string
	if reactionTool != nil {
		reactionEmojis = strings.Split(discordReactionEmojis, ",")
	}
	return grouptrigger.DecideViaLLM(ctx, grouptrigger.LLMDecisionOptions{
		Client: opts.Client, Model: model, Scene: "discord.addressing_decision",
		SystemPrompt: systemPrompt, UserPrompt: userPrompt, ReactionEmojis: reactionEmojis,
	})
}
