package discord

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/discordapi"
)

// discordSlashCommands are the shared chat commands, registered as Discord slash commands. A slash
// command runs as the text command it names ("/models gpt-5"), with the options as its arguments.
func discordSlashCommands() []discordapi.ApplicationCommand {
	contexts := []int{discordapi.InteractionContextGuild, discordapi.InteractionContextBotDM}
	args := func(description string, required bool) []discordapi.ApplicationCommandOption {
		return []discordapi.ApplicationCommandOption{{Type: discordapi.CommandOptionString, Name: "args", Description: description, Required: required}}
	}
	commands := []discordapi.ApplicationCommand{
		{Name: "help", Description: "Show available commands"},
		{Name: "models", Description: "Inspect or change the active model", Options: args("Model name or subcommand", false)},
		{Name: "think", Description: "Run a task with extra-high reasoning", Options: args("The task", true)},
		{Name: "skills", Description: "Show loaded skills"},
		{Name: "ctx", Description: "Show or compact context usage", Options: args("compact to compact the context", false)},
		{Name: "workspace", Description: "Show or change the workspace", Options: args("Workspace path or subcommand", false)},
		{Name: "reset", Description: "Clear conversation history and sticky skills"},
		{Name: "stop", Description: "Stop the running task"},
		{Name: "id", Description: "Show this chat's and your IDs"},
		{Name: "approve", Description: "Approve a pending tool call", Options: args("Approval ID", true)},
		{Name: "deny", Description: "Deny a pending tool call", Options: args("Approval ID", true)},
		{Name: "pair", Description: "Pair with another Morph Agent (DM only)", Options: []discordapi.ApplicationCommandOption{
			{Type: discordapi.CommandOptionUser, Name: "agent", Description: "The Agent's bot user", Required: true},
		}},
	}
	for index := range commands {
		commands[index].Contexts = contexts
	}
	return commands
}

// discordSlashCommandText is the text command a slash command stands for.
func discordSlashCommandText(data discordapi.InteractionData) string {
	name := strings.TrimSpace(data.Name)
	if name == "" {
		return ""
	}
	parts := []string{"/" + name}
	for _, option := range data.Options {
		value := strings.TrimSpace(option.StringValue())
		if value == "" {
			continue
		}
		if option.Type == discordapi.CommandOptionUser {
			value = "<@" + value + ">"
		}
		parts = append(parts, value)
	}
	return strings.Join(parts, " ")
}

// discordSlashCommandMessage turns a slash command into the message it stands for, so it takes the
// same path as a typed one: the interaction ID is its message ID, and it mentions the bot, since a
// slash command is always addressed to it.
func discordSlashCommandMessage(interaction discordapi.Interaction, botID string, now time.Time) (discordapi.Message, bool) {
	text := discordSlashCommandText(interaction.Data)
	actor := interaction.Actor()
	if text == "" || strings.TrimSpace(actor.ID) == "" || strings.TrimSpace(interaction.ChannelID) == "" {
		return discordapi.Message{}, false
	}
	msg := discordapi.Message{
		ID: interaction.ID, ChannelID: interaction.ChannelID, GuildID: interaction.GuildID, Author: actor,
		Content: text, Timestamp: now.UTC(), Type: discordapi.MessageTypeDefault, Mentions: []discordapi.User{{ID: botID}},
	}
	if interaction.Member != nil && strings.TrimSpace(interaction.Member.Nick) != "" {
		msg.Member = &discordapi.Member{Nick: interaction.Member.Nick}
	}
	return msg, true
}

// discordInteractionTokenTTL is how long an interaction token is used: Discord accepts it for 15
// minutes.
const discordInteractionTokenTTL = 14 * time.Minute

// discordInteractionReplies answers slash commands. Each one is acknowledged at once with Discord's
// "thinking…" placeholder; the first message sent in reply to it (its interaction ID as the reply
// target) replaces the placeholder, and later replies refer to that message.
type discordInteractionReplies struct {
	api    discordAPI
	logger *slog.Logger
	now    func() time.Time

	mu       sync.Mutex
	appID    string
	pending  map[string]discordPendingInteraction
	answered map[string]discordAnsweredInteraction
}

type discordPendingInteraction struct {
	token string
	at    time.Time
}

type discordAnsweredInteraction struct {
	messageID string
	at        time.Time
}

func newDiscordInteractionReplies(api discordAPI, logger *slog.Logger) *discordInteractionReplies {
	if logger == nil {
		logger = slog.Default()
	}
	return &discordInteractionReplies{
		api: api, logger: logger, now: time.Now,
		pending: make(map[string]discordPendingInteraction), answered: make(map[string]discordAnsweredInteraction),
	}
}

func (r *discordInteractionReplies) setApplicationID(id string) {
	r.mu.Lock()
	r.appID = strings.TrimSpace(id)
	r.mu.Unlock()
}

func (r *discordInteractionReplies) add(interactionID, token string) {
	now := r.now()
	r.mu.Lock()
	defer r.mu.Unlock()
	for id, answered := range r.answered {
		if now.Sub(answered.at) > time.Hour {
			delete(r.answered, id)
		}
	}
	for id, pending := range r.pending {
		if now.Sub(pending.at) > discordInteractionTokenTTL {
			delete(r.pending, id)
		}
	}
	r.pending[interactionID] = discordPendingInteraction{token: token, at: now}
}

// known reports whether id is a slash command's interaction ID.
func (r *discordInteractionReplies) known(id string) bool {
	if r == nil || strings.TrimSpace(id) == "" {
		return false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	_, pending := r.pending[id]
	_, answered := r.answered[id]
	return pending || answered
}

// take returns the token of a placeholder still waiting for its answer, and stops waiting for it.
func (r *discordInteractionReplies) take(id string) (appID, token string, ok bool) {
	if r == nil || strings.TrimSpace(id) == "" {
		return "", "", false
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	pending, found := r.pending[id]
	if !found {
		return "", "", false
	}
	delete(r.pending, id)
	if r.appID == "" || r.now().Sub(pending.at) > discordInteractionTokenTTL {
		return "", "", false
	}
	return r.appID, pending.token, true
}

// reference is the message a reply to replyTo refers to: the answer that replaced a slash command's
// placeholder, or replyTo itself.
func (r *discordInteractionReplies) reference(replyTo string) string {
	if r == nil {
		return replyTo
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if answered, found := r.answered[replyTo]; found {
		return answered.messageID
	}
	return replyTo
}

// send sends text in reply to replyTo, filling a waiting slash command placeholder first.
func (r *discordInteractionReplies) send(ctx context.Context, channelID, text, replyTo string) error {
	if appID, token, ok := r.take(replyTo); ok {
		parts := discordapi.SplitContent(text, discordapi.MaxMessageLength)
		if len(parts) > 0 {
			message, err := r.api.EditInteractionResponse(ctx, appID, token, discordapi.MessageEdit{Content: &parts[0], AllowedMentions: discordapi.NoMentions()})
			if err == nil {
				r.mu.Lock()
				r.answered[replyTo] = discordAnsweredInteraction{messageID: message.ID, at: r.now()}
				r.mu.Unlock()
				if rest := strings.Join(parts[1:], "\n\n"); strings.TrimSpace(rest) != "" {
					_, err = sendDiscordText(ctx, r.api, channelID, rest, "")
				}
				return err
			}
			r.logger.Warn("discord_interaction_response_edit_failed", "channel_id", channelID, "interaction_id", replyTo, "error", err.Error())
		}
	}
	_, err := sendDiscordText(ctx, r.api, channelID, text, r.reference(replyTo))
	return err
}

// finish removes a placeholder nothing answered, such as after a run that only reacted.
func (r *discordInteractionReplies) finish(ctx context.Context, id string) {
	appID, token, ok := r.take(id)
	if !ok {
		return
	}
	if err := r.api.DeleteInteractionResponse(ctx, appID, token); err != nil {
		r.logger.Warn("discord_interaction_response_delete_failed", "interaction_id", id, "error", err.Error())
	}
}
