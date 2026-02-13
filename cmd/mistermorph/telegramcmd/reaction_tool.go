package telegramcmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

type telegramReaction struct {
	ChatID    int64
	MessageID int64
	Emoji     string
	Source    string
}

type telegramReactTool struct {
	api              *telegramAPI
	defaultChatID    int64
	defaultMessageID int64
	allowedIDs       map[int64]bool
	enabled          bool
	lastReaction     *telegramReaction
}

func newTelegramReactTool(api *telegramAPI, defaultChatID int64, defaultMessageID int64, allowedIDs map[int64]bool) *telegramReactTool {
	return &telegramReactTool{
		api:              api,
		defaultChatID:    defaultChatID,
		defaultMessageID: defaultMessageID,
		allowedIDs:       allowedIDs,
		enabled:          true,
	}
}

func (t *telegramReactTool) Name() string { return "telegram_react" }

func (t *telegramReactTool) Description() string {
	return "Adds an emoji reaction to a Telegram message. Use when a light confirmation is sufficient; do not send an extra text reply when reaction alone is enough."
}

func (t *telegramReactTool) ParameterSchema() string {
	s := map[string]any{
		"type":                 "object",
		"additionalProperties": false,
		"properties": map[string]any{
			"chat_id": map[string]any{
				"type":        "integer",
				"description": "Target Telegram chat_id. Optional in active chat context; required when reacting outside the current chat.",
			},
			"message_id": map[string]any{
				"type":        "integer",
				"description": "Target Telegram message_id. Optional in active chat context; defaults to the triggering message.",
			},
			"emoji": map[string]any{
				"type":        "string",
				"description": "Emoji to react with.",
			},
			"is_big": map[string]any{
				"type":        "boolean",
				"description": "Optional big reaction flag.",
			},
		},
		"required": []string{"emoji"},
	}
	b, _ := json.MarshalIndent(s, "", "  ")
	return string(b)
}

func (t *telegramReactTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	if !t.enabled || t.api == nil {
		return "", fmt.Errorf("telegram_react is disabled")
	}

	chatID := t.defaultChatID
	if v, ok := params["chat_id"]; ok {
		switch x := v.(type) {
		case int64:
			chatID = x
		case int:
			chatID = int64(x)
		case float64:
			chatID = int64(x)
		}
	}
	if chatID == 0 {
		return "", fmt.Errorf("missing required param: chat_id")
	}
	if len(t.allowedIDs) > 0 && !t.allowedIDs[chatID] {
		return "", fmt.Errorf("unauthorized chat_id: %d", chatID)
	}

	messageID := t.defaultMessageID
	if v, ok := params["message_id"]; ok {
		switch x := v.(type) {
		case int64:
			messageID = x
		case int:
			messageID = int64(x)
		case float64:
			messageID = int64(x)
		}
	}
	if messageID == 0 {
		return "", fmt.Errorf("missing required param: message_id")
	}

	emoji, _ := params["emoji"].(string)
	emoji = strings.TrimSpace(emoji)
	if emoji == "" {
		return "", fmt.Errorf("missing required param: emoji")
	}

	var isBigPtr *bool
	if v, ok := params["is_big"]; ok {
		if b, ok := v.(bool); ok {
			isBig := b
			isBigPtr = &isBig
		}
	}

	if err := t.api.setMessageReaction(ctx, chatID, messageID, []telegramReactionType{
		{Type: "emoji", Emoji: emoji},
	}, isBigPtr); err != nil {
		return "", err
	}

	t.lastReaction = &telegramReaction{
		ChatID:    chatID,
		MessageID: messageID,
		Emoji:     emoji,
		Source:    "tool",
	}
	return fmt.Sprintf("reacted with %s", emoji), nil
}

func (t *telegramReactTool) LastReaction() *telegramReaction {
	if t == nil {
		return nil
	}
	return t.lastReaction
}
