package discordapi

import (
	"encoding/json"
	"fmt"
	"strings"
)

// Dispatch event types the channel reads.
const (
	EventReady             = "READY"
	EventMessageCreate     = "MESSAGE_CREATE"
	EventInteractionCreate = "INTERACTION_CREATE"
	EventGuildCreate       = "GUILD_CREATE"
)

type ReadyEvent struct {
	User        User   `json:"user"`
	SessionID   string `json:"session_id"`
	Application struct {
		ID string `json:"id"`
	} `json:"application"`
}

// Interaction types: a slash command, and a click on a message component such as a button.
const (
	InteractionTypeApplicationCommand = 2
	InteractionTypeMessageComponent   = 3
)

type InteractionMember struct {
	User User   `json:"user"`
	Nick string `json:"nick,omitempty"`
}

type InteractionData struct {
	CustomID      string `json:"custom_id,omitempty"`
	ComponentType int    `json:"component_type,omitempty"`
	// Name and Options are set for a slash command.
	Name    string              `json:"name,omitempty"`
	Options []InteractionOption `json:"options,omitempty"`
}

// InteractionOption is one option a user filled in a slash command. Value is a string, number or
// boolean, or a snowflake string for user, channel and role options.
type InteractionOption struct {
	Name  string          `json:"name"`
	Type  int             `json:"type"`
	Value json.RawMessage `json:"value,omitempty"`
}

// StringValue is the option's value as text.
func (o InteractionOption) StringValue() string {
	raw := strings.TrimSpace(string(o.Value))
	if raw == "" || raw == "null" {
		return ""
	}
	var text string
	if err := json.Unmarshal(o.Value, &text); err == nil {
		return text
	}
	return raw
}

type Interaction struct {
	ID        string             `json:"id"`
	Token     string             `json:"token"`
	Type      int                `json:"type"`
	GuildID   string             `json:"guild_id,omitempty"`
	ChannelID string             `json:"channel_id,omitempty"`
	Member    *InteractionMember `json:"member,omitempty"`
	User      *User              `json:"user,omitempty"`
	Data      InteractionData    `json:"data"`
	Message   *Message           `json:"message,omitempty"`
}

// Actor is the user who acted: the member in a server, the user in a DM.
func (i Interaction) Actor() User {
	if i.Member != nil && strings.TrimSpace(i.Member.User.ID) != "" {
		return i.Member.User
	}
	if i.User != nil {
		return *i.User
	}
	return User{}
}

// DecodeEvent decodes a dispatch's payload into target, checking its type.
func DecodeEvent(event Event, eventType string, target any) error {
	if event.Type != eventType {
		return fmt.Errorf("discord event is %s, not %s", event.Type, eventType)
	}
	if err := json.Unmarshal(event.Data, target); err != nil {
		return fmt.Errorf("decode discord %s: %w", eventType, err)
	}
	return nil
}
