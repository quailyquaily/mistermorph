package discord

import (
	"context"
	"fmt"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/agentpair"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	discordbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/discord"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
	"github.com/quailyquaily/mistermorph/internal/workspace"
)

// maybeHandleDiscordCommand runs a shared chat command. It reports whether text was a command and
// whether a reply was sent.
func maybeHandleDiscordCommand(ctx context.Context, d Dependencies, bus *busruntime.Inproc, store *workspace.Store, conversationKey string, inbound discordbus.InboundMessage, replyTo string, currentSkills []string, reset func(context.Context) error) (handled bool, replied bool, err error) {
	registry := chatcommands.NewRuntimeRegistry(chatcommands.RuntimeRegistryOptions{
		ModelCommand:        d.HandleModelCommand,
		SkillCommand:        skillCommandForDiscord(d.HandleSkillCommand, currentSkills),
		ContextCommand:      topiccontext.NewStore(d.RuntimePaths.TopicContextPath).CommandFunc(conversationKey),
		WorkspaceStore:      store,
		WorkspaceKey:        conversationKey,
		DefaultWorkspaceDir: d.DefaultWorkspaceDir,
	})
	registry.Register("/id", "show the current Discord channel and user ids", func(context.Context, string) (*chatcommands.Result, error) {
		return &chatcommands.Result{Reply: discordIDText(inbound)}, nil
	})
	if reset != nil {
		registry.Register("/reset", "clear conversation history and sticky skills", func(commandCtx context.Context, _ string) (*chatcommands.Result, error) {
			if err := reset(commandCtx); err != nil {
				return nil, err
			}
			return &chatcommands.Result{Reply: "ok (reset)"}, nil
		})
	}
	result, handled, err := registry.Dispatch(ctx, inbound.Text)
	if !handled {
		return false, false, nil
	}
	if result != nil && result.Action == chatcommands.ActionContextCompact {
		return false, false, nil
	}
	output := ""
	if err != nil {
		output = "error: " + strings.TrimSpace(err.Error())
	} else if result != nil {
		output = strings.TrimSpace(result.Reply)
	}
	if output == "" {
		return true, false, nil
	}
	return true, true, publishDiscordBusOutbound(ctx, bus, inbound.ChannelID, output, replyTo, fmt.Sprintf("discord:command:%s:%s", inbound.ChannelID, inbound.MessageID))
}

func discordIDText(inbound discordbus.InboundMessage) string {
	parts := []string{"chat_id=discord:" + inbound.ChannelID}
	if inbound.GuildID != "" {
		parts = append(parts, "guild_id="+inbound.GuildID)
	}
	parts = append(parts, "type="+inbound.ChatType, "user=discord_user:"+inbound.UserID)
	return strings.Join(parts, " ")
}

func skillCommandForDiscord(fn HandleSkillCommandFunc, currentSkills []string) chatcommands.SkillCommandFunc {
	if fn == nil {
		return nil
	}
	snapshot := append([]string(nil), currentSkills...)
	return func() (string, error) { return fn(snapshot) }
}

func discordCommandName(text string) string {
	command, _ := chatcommands.ParseCommand(text)
	return chatcommands.NormalizeCommand(command)
}

// discordBypassesAllowlist is true for what must work before a user is allowed: finding one's IDs
// and agent pairing.
func discordBypassesAllowlist(text string) bool {
	if agentpair.IsControlMessage(text) {
		return true
	}
	switch discordCommandName(text) {
	case "/id", "/pair":
		return true
	default:
		return false
	}
}

// discordInboundReplyTarget is the message a reply refers to: the triggering one in servers, and a
// slash command (fromInteraction) anywhere, since its reply fills the command's placeholder.
func discordInboundReplyTarget(inbound discordbus.InboundMessage, fromInteraction bool) string {
	if inbound.ChatType == discordbus.ChatTypeGroup || fromInteraction {
		return inbound.MessageID
	}
	return ""
}

// discordAddressed reports whether a message mentions or replies to the bot; ingress records both
// as the bot's ID among the mentions.
func discordAddressed(inbound discordbus.InboundMessage, botID string) bool {
	for _, id := range inbound.MentionUserIDs {
		if id == botID {
			return true
		}
	}
	return false
}
