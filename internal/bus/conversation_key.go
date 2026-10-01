package bus

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

func BuildConversationKey(channel Channel, id string) (string, error) {
	prefix := conversationKeyPrefix(channel)
	if prefix == "" {
		return "", fmt.Errorf("channel is invalid")
	}
	id = strings.TrimSpace(id)
	if id == "" {
		return "", fmt.Errorf("conversation id is required")
	}
	if strings.Contains(id, " ") {
		return "", fmt.Errorf("conversation id must not contain spaces")
	}
	return fmt.Sprintf("%s:%s", prefix, id), nil
}

func BuildTelegramChatConversationKey(chatID string) (string, error) {
	return BuildConversationKey(ChannelTelegram, chatID)
}

func BuildTelegramTopicConversationKey(chatID string, messageThreadID int64) (string, error) {
	chatID = strings.TrimSpace(chatID)
	if messageThreadID <= 0 {
		return BuildTelegramChatConversationKey(chatID)
	}
	return BuildTelegramChatConversationKey(chatID + "_" + strconv.FormatInt(messageThreadID, 10))
}

func ParseTelegramConversationKey(conversationKey string) (int64, int64, error) {
	const prefix = "tg:"
	key := strings.TrimSpace(conversationKey)
	if !strings.HasPrefix(strings.ToLower(key), prefix) {
		return 0, 0, fmt.Errorf("telegram conversation key is invalid")
	}
	raw := strings.TrimSpace(key[len(prefix):])
	if raw == "" {
		return 0, 0, fmt.Errorf("telegram chat id is required")
	}
	parts := strings.Split(raw, "_")
	if len(parts) > 2 {
		return 0, 0, fmt.Errorf("telegram conversation key is invalid")
	}
	chatID, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("telegram chat id is invalid: %w", err)
	}
	if chatID == 0 {
		return 0, 0, fmt.Errorf("telegram chat id is required")
	}
	if len(parts) == 1 {
		return chatID, 0, nil
	}
	messageThreadID, err := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
	if err != nil {
		return 0, 0, fmt.Errorf("telegram message thread id is invalid: %w", err)
	}
	if messageThreadID <= 0 {
		return 0, 0, fmt.Errorf("telegram message thread id is invalid")
	}
	return chatID, messageThreadID, nil
}

func BuildSlackChannelConversationKey(channelID string) (string, error) {
	return BuildConversationKey(ChannelSlack, channelID)
}

func BuildLineConversationKey(chatID string) (string, error) {
	return BuildConversationKey(ChannelLine, chatID)
}

func BuildLarkConversationKey(chatID string) (string, error) {
	return BuildConversationKey(ChannelLark, chatID)
}

func BuildMixinConversationKey(conversationID string) (string, error) {
	conversationID = strings.TrimSpace(conversationID)
	id, err := uuid.Parse(conversationID)
	if err != nil || id == uuid.Nil {
		return "", fmt.Errorf("mixin conversation id is invalid")
	}
	return BuildConversationKey(ChannelMixin, id.String())
}

// BuildDiscordConversationKey keys a Discord channel, thread or DM channel by its snowflake ID.
func BuildDiscordConversationKey(channelID string) (string, error) {
	channelID, err := normalizeDiscordSnowflake(channelID)
	if err != nil {
		return "", err
	}
	return BuildConversationKey(ChannelDiscord, channelID)
}

func ParseDiscordConversationKey(conversationKey string) (string, error) {
	const prefix = "discord:"
	value := strings.TrimSpace(conversationKey)
	if !strings.HasPrefix(strings.ToLower(value), prefix) {
		return "", fmt.Errorf("discord conversation key is invalid")
	}
	return normalizeDiscordSnowflake(value[len(prefix):])
}

func normalizeDiscordSnowflake(value string) (string, error) {
	value = strings.TrimSpace(value)
	id, err := strconv.ParseUint(value, 10, 64)
	if err != nil || id == 0 {
		return "", fmt.Errorf("discord channel id is invalid")
	}
	return strconv.FormatUint(id, 10), nil
}

// BuildAccountConversationKey keys a private conversation of a bound account with one peer:
// "<prefix>:<account>:<peer>". WeChat and WhatsApp keep the account in the key, so rebinding to
// another account never reads the old account's history. Neither part may contain ":" or spaces.
func BuildAccountConversationKey(channel Channel, accountID, peerID string) (string, error) {
	accountID = strings.TrimSpace(accountID)
	peerID = strings.TrimSpace(peerID)
	for _, part := range []string{accountID, peerID} {
		if part == "" || strings.ContainsAny(part, ": \t\r\n") {
			return "", fmt.Errorf("%s conversation part %q is invalid", channel, part)
		}
	}
	return BuildConversationKey(channel, accountID+":"+peerID)
}

// ParseAccountConversationKey reads back BuildAccountConversationKey: the account and the peer.
func ParseAccountConversationKey(channel Channel, conversationKey string) (string, string, error) {
	prefix := conversationKeyPrefix(channel)
	value := strings.TrimSpace(conversationKey)
	if prefix == "" || !strings.HasPrefix(value, prefix+":") {
		return "", "", fmt.Errorf("%s conversation key is invalid", channel)
	}
	parts := strings.SplitN(value[len(prefix)+1:], ":", 3)
	if len(parts) != 2 || strings.TrimSpace(parts[0]) == "" || strings.TrimSpace(parts[1]) == "" {
		return "", "", fmt.Errorf("%s conversation key is invalid", channel)
	}
	return parts[0], parts[1], nil
}

func ParseMixinConversationKey(conversationKey string) (string, error) {
	const prefix = "mixin:"
	value := strings.TrimSpace(conversationKey)
	if !strings.HasPrefix(strings.ToLower(value), prefix) {
		return "", fmt.Errorf("mixin conversation key is invalid")
	}
	id, err := uuid.Parse(strings.TrimSpace(value[len(prefix):]))
	if err != nil || id == uuid.Nil {
		return "", fmt.Errorf("mixin conversation id is invalid")
	}
	return id.String(), nil
}

func conversationKeyPrefix(channel Channel) string {
	switch channel {
	case ChannelConsole:
		return "console"
	case ChannelTelegram:
		return "tg"
	case ChannelSlack:
		return "slack"
	case ChannelLine:
		return "line"
	case ChannelLark:
		return "lark"
	case ChannelDiscord:
		return "discord"
	case ChannelMixin:
		return "mixin"
	case ChannelWeChat:
		return "wechat"
	case ChannelWhatsApp:
		return "whatsapp"
	default:
		return ""
	}
}
