package discord

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"
)

// ReactTool adds a reaction to a message in the current conversation.
type ReactTool struct {
	api              API
	channelID        string
	defaultMessageID string
	lastReaction     *Reaction
}

var customEmojiPattern = regexp.MustCompile(`^<?a?:?([A-Za-z0-9_]{2,32}):([0-9]{5,25})>?$`)

func NewReactTool(api API, channelID, defaultMessageID string) *ReactTool {
	return &ReactTool{api: api, channelID: strings.TrimSpace(channelID), defaultMessageID: strings.TrimSpace(defaultMessageID)}
}

func (t *ReactTool) Name() string { return "message_react" }

func (t *ReactTool) Description() string {
	return "Adds an emoji reaction to a Discord message in this conversation. Prefer this for lightweight acknowledgements. " +
		"Use a Unicode emoji such as 👍, or a server's custom emoji as <:name:id>."
}

func (t *ReactTool) ParameterSchema() string {
	schema := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"message_id": map[string]any{"type": "string", "description": "Message to react to. Optional; defaults to the triggering message."},
			"emoji":      map[string]any{"type": "string", "description": "A Unicode emoji, or a custom emoji as <:name:id>."},
		},
		"required": []string{"emoji"},
	}
	raw, _ := json.MarshalIndent(schema, "", "  ")
	return string(raw)
}

func (t *ReactTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if t == nil || t.api == nil || t.channelID == "" {
		return "", fmt.Errorf("message_react is disabled")
	}
	messageID := t.defaultMessageID
	if v, ok := params["message_id"].(string); ok && strings.TrimSpace(v) != "" {
		messageID = strings.TrimSpace(v)
	}
	if messageID == "" {
		return "", fmt.Errorf("missing required param: message_id")
	}
	raw, _ := params["emoji"].(string)
	emoji, err := NormalizeEmoji(raw)
	if err != nil {
		return "", err
	}
	if err := t.api.AddReaction(ctx, t.channelID, messageID, emoji); err != nil {
		return "", err
	}
	t.lastReaction = &Reaction{ChannelID: t.channelID, MessageID: messageID, Emoji: emoji, Source: "tool"}
	return "reacted with " + strings.TrimSpace(raw), nil
}

// LastReaction is the reaction the tool added last, or nil.
func (t *ReactTool) LastReaction() *Reaction {
	if t == nil {
		return nil
	}
	return t.lastReaction
}

// NormalizeEmoji turns an emoji into the form Discord's reaction route takes: the Unicode emoji
// itself, or "name:id" for a custom one.
func NormalizeEmoji(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", fmt.Errorf("missing required param: emoji")
	}
	if match := customEmojiPattern.FindStringSubmatch(value); match != nil {
		return match[1] + ":" + match[2], nil
	}
	if strings.ContainsAny(value, " \t\r\n:<>/") || utf8.RuneCountInString(value) > 8 {
		return "", fmt.Errorf("emoji is invalid: %s", raw)
	}
	for _, r := range value {
		if r < 0x80 {
			return "", fmt.Errorf("emoji must be a Unicode emoji or <:name:id>: %s", raw)
		}
	}
	return value, nil
}
