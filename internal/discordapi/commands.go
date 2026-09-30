package discordapi

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
)

// Application command option types used by the channel.
const (
	CommandOptionString = 3
	CommandOptionUser   = 6
)

// Interaction contexts a command is offered in: server channels and DMs with the bot.
const (
	InteractionContextGuild = 0
	InteractionContextBotDM = 1
)

// InteractionResponseDeferredChannelMessage acknowledges a slash command; the answer is edited in
// later (EditInteractionResponse) while Discord shows "thinking…".
const InteractionResponseDeferredChannelMessage = 5

type ApplicationCommandOption struct {
	Type        int    `json:"type"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Required    bool   `json:"required,omitempty"`
}

type ApplicationCommand struct {
	Name        string                     `json:"name"`
	Description string                     `json:"description"`
	Type        int                        `json:"type,omitempty"`
	Options     []ApplicationCommandOption `json:"options,omitempty"`
	Contexts    []int                      `json:"contexts,omitempty"`
}

// SetGlobalCommands replaces the application's global slash commands with commands.
func (c *Client) SetGlobalCommands(ctx context.Context, applicationID string, commands []ApplicationCommand) error {
	if err := requireID("application_id", applicationID); err != nil {
		return err
	}
	if commands == nil {
		commands = []ApplicationCommand{}
	}
	path := "/applications/" + applicationID + "/commands"
	return c.do(ctx, http.MethodPut, path, "applications/commands", commands, nil)
}

// EditInteractionResponse replaces the answer to an interaction (the "thinking…" placeholder of a
// deferred one). Like the callback, it is authorized by the interaction token, not the bot token;
// the token is valid for 15 minutes.
func (c *Client) EditInteractionResponse(ctx context.Context, applicationID, token string, edit MessageEdit) (Message, error) {
	path, err := interactionResponsePath(applicationID, token)
	if err != nil {
		return Message{}, err
	}
	if edit.Content != nil && len([]rune(*edit.Content)) > MaxMessageLength {
		return Message{}, fmt.Errorf("discord message is longer than %d characters", MaxMessageLength)
	}
	var edited Message
	err = c.doAuth(ctx, http.MethodPatch, path, "webhooks/messages/@original", edit, &edited, false)
	return edited, err
}

// DeleteInteractionResponse removes the answer to an interaction, such as a placeholder that got no
// answer.
func (c *Client) DeleteInteractionResponse(ctx context.Context, applicationID, token string) error {
	path, err := interactionResponsePath(applicationID, token)
	if err != nil {
		return err
	}
	return c.doAuth(ctx, http.MethodDelete, path, "webhooks/messages/@original", nil, nil, false)
}

func interactionResponsePath(applicationID, token string) (string, error) {
	if err := requireID("application_id", applicationID); err != nil {
		return "", err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		return "", fmt.Errorf("discord interaction token is required")
	}
	return "/webhooks/" + applicationID + "/" + url.PathEscape(token) + "/messages/@original", nil
}
