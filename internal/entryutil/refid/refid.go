package refid

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// Protocol names allow lowercase letters/digits/underscore.
var protocolPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)

// Parse parses a generic reference id in "protocol:id" form.
func Parse(raw string) (protocol string, id string, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", false
	}
	idx := strings.IndexByte(raw, ':')
	if idx <= 0 || idx >= len(raw)-1 {
		return "", "", false
	}
	protocol = strings.ToLower(strings.TrimSpace(raw[:idx]))
	id = strings.TrimSpace(raw[idx+1:])
	if id == "" {
		return "", "", false
	}
	if !protocolPattern.MatchString(protocol) {
		return "", "", false
	}
	if strings.ContainsAny(id, " \t\r\n()") {
		return "", "", false
	}
	return protocol, id, true
}

// IsValid reports whether raw matches "protocol:id".
func IsValid(raw string) bool {
	_, _, ok := Parse(raw)
	return ok
}

// Normalize lowercases protocol and keeps id as-is.
func Normalize(raw string) (string, bool) {
	protocol, id, ok := Parse(raw)
	if !ok {
		return "", false
	}
	return protocol + ":" + id, true
}

// ParseTelegramChatIDHint parses "tg:<int64>" and "tg:<int64>_<message_thread_id>" chat hints.
// Empty input returns (0, false, nil).
func ParseTelegramChatIDHint(raw string) (int64, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, false, nil
	}
	if !strings.HasPrefix(strings.ToLower(value), "tg:") {
		return 0, true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	value = strings.TrimSpace(value[len("tg:"):])
	parts := strings.Split(value, "_")
	if len(parts) > 2 {
		return 0, true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	chatID, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
	if err != nil || chatID == 0 {
		return 0, true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	if len(parts) == 2 {
		messageThreadID, threadErr := strconv.ParseInt(strings.TrimSpace(parts[1]), 10, 64)
		if threadErr != nil || messageThreadID <= 0 {
			return 0, true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
		}
	}
	return chatID, true, nil
}

// ParseSlackChatIDHint parses "slack:<team_id>:<channel_id>" chat hints.
// Empty input returns ("", "", false, nil).
func ParseSlackChatIDHint(raw string) (string, string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", "", false, nil
	}
	if !strings.HasPrefix(strings.ToLower(value), "slack:") {
		return "", "", false, nil
	}
	suffix := strings.TrimSpace(value[len("slack:"):])
	parts := strings.Split(suffix, ":")
	if len(parts) != 2 {
		return "", "", true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	teamID := strings.TrimSpace(parts[0])
	channelID := strings.TrimSpace(parts[1])
	if teamID == "" || channelID == "" {
		return "", "", true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	return teamID, channelID, true, nil
}

// ParseLineChatIDHint parses "line:<chat_id>" chat hints.
// Empty input returns ("", false, nil).
func ParseLineChatIDHint(raw string) (string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", false, nil
	}
	if !strings.HasPrefix(strings.ToLower(value), "line:") {
		return "", false, nil
	}
	chatID := strings.TrimSpace(value[len("line:"):])
	if chatID == "" {
		return "", true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	return chatID, true, nil
}

// ParseLarkChatIDHint parses "lark:<chat_id>" chat hints.
// Empty input returns ("", false, nil).
func ParseLarkChatIDHint(raw string) (string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", false, nil
	}
	if !strings.HasPrefix(strings.ToLower(value), "lark:") {
		return "", false, nil
	}
	chatID := NormalizeLarkID(value[len("lark:"):])
	if chatID == "" {
		return "", true, fmt.Errorf("invalid chat_id: %s", strings.TrimSpace(raw))
	}
	return chatID, true, nil
}

// NormalizeLineID trims surrounding spaces.
func NormalizeLineID(raw string) string {
	return strings.TrimSpace(raw)
}

// NormalizeLarkID trims surrounding spaces.
func NormalizeLarkID(raw string) string {
	return strings.TrimSpace(raw)
}

// ParseLineChatContactID parses "line:<chat_id>" contact IDs.
func ParseLineChatContactID(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(value), "line:") {
		return "", false
	}
	chatID := NormalizeLineID(value[len("line:"):])
	if chatID == "" {
		return "", false
	}
	return chatID, true
}

// ParseLarkChatContactID parses "lark:<chat_id>" contact IDs.
func ParseLarkChatContactID(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(value), "lark:") {
		return "", false
	}
	chatID := NormalizeLarkID(value[len("lark:"):])
	if chatID == "" {
		return "", false
	}
	return chatID, true
}

// ParseLineUserContactID parses "line_user:<user_id>" contact IDs.
func ParseLineUserContactID(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(value), "line_user:") {
		return "", false
	}
	userID := NormalizeLineID(value[len("line_user:"):])
	if userID == "" {
		return "", false
	}
	return userID, true
}

// ParseLarkUserContactID parses "lark_user:<open_id>" contact IDs.
func ParseLarkUserContactID(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(value), "lark_user:") {
		return "", false
	}
	openID := NormalizeLarkID(value[len("lark_user:"):])
	if openID == "" {
		return "", false
	}
	return openID, true
}

// NormalizeMixinID returns the canonical UUID used by Mixin users and conversations.
func NormalizeMixinID(raw string) string {
	id, err := uuid.Parse(strings.TrimSpace(raw))
	if err != nil || id == uuid.Nil {
		return ""
	}
	return id.String()
}

// ParseMixinChatIDHint parses "mixin:<conversation_uuid>".
func ParseMixinChatIDHint(raw string) (string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" || !strings.HasPrefix(strings.ToLower(value), "mixin:") {
		return "", false, nil
	}
	id := NormalizeMixinID(value[len("mixin:"):])
	if id == "" {
		return "", true, fmt.Errorf("invalid chat_id: %s", value)
	}
	return id, true, nil
}

// ParseMixinContactID parses "mixin:<user_uuid>".
func ParseMixinContactID(raw string) (string, bool) {
	id, hasHint, err := ParseMixinChatIDHint(raw)
	return id, hasHint && err == nil
}

// NormalizeDiscordID returns a Discord snowflake ID in canonical decimal form, or "".
func NormalizeDiscordID(raw string) string {
	id, err := strconv.ParseUint(strings.TrimSpace(raw), 10, 64)
	if err != nil || id == 0 {
		return ""
	}
	return strconv.FormatUint(id, 10)
}

// ParseDiscordChatIDHint parses "discord:<channel_id>": a channel, thread or DM channel.
func ParseDiscordChatIDHint(raw string) (string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" || !strings.HasPrefix(strings.ToLower(value), "discord:") {
		return "", false, nil
	}
	id := NormalizeDiscordID(value[len("discord:"):])
	if id == "" {
		return "", true, fmt.Errorf("invalid chat_id: %s", value)
	}
	return id, true, nil
}

// ParseDiscordUserContactID parses "discord_user:<user_id>" contact IDs.
func ParseDiscordUserContactID(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(value), "discord_user:") {
		return "", false
	}
	userID := NormalizeDiscordID(value[len("discord_user:"):])
	if userID == "" {
		return "", false
	}
	return userID, true
}

// LineIDLooksLikeUserID reports whether ID shape looks like a LINE user id.
func LineIDLooksLikeUserID(value string) bool {
	return strings.HasPrefix(strings.ToUpper(strings.TrimSpace(value)), "U")
}

// NormalizeWeChatID returns a WeChat iLink user or bot ID, or "" when it is empty or holds ":" or
// spaces (IDs are opaque, such as "o9cq...@im.wechat").
func NormalizeWeChatID(raw string) string {
	value := strings.TrimSpace(raw)
	if value == "" || strings.ContainsAny(value, ": \t\r\n") {
		return ""
	}
	return value
}

// ParseWeChatChatIDHint parses a "wechat:<user_id>" chat id into the user's id.
func ParseWeChatChatIDHint(raw string) (string, bool, error) {
	return parseChatIDHint(raw, "wechat:", NormalizeWeChatID)
}

// ParseWhatsAppChatIDHint parses a "whatsapp:<user_id>" chat id into the user's id.
func ParseWhatsAppChatIDHint(raw string) (string, bool, error) {
	return parseChatIDHint(raw, "whatsapp:", NormalizeWhatsAppID)
}

func parseChatIDHint(raw, prefix string, normalize func(string) string) (string, bool, error) {
	value := strings.TrimSpace(raw)
	if value == "" || !strings.HasPrefix(strings.ToLower(value), prefix) {
		return "", false, nil
	}
	id := normalize(value[len(prefix):])
	if id == "" {
		return "", true, fmt.Errorf("invalid chat_id: %s", value)
	}
	return id, true, nil
}

// ParseWeChatUserContactID parses "wechat_user:<id>" contact IDs.
func ParseWeChatUserContactID(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(value), "wechat_user:") {
		return "", false
	}
	id := NormalizeWeChatID(value[len("wechat_user:"):])
	return id, id != ""
}

// NormalizeWhatsAppID returns a WhatsApp user ID without its "user:" prefix (the API's ids are
// integers), or "".
func NormalizeWhatsAppID(raw string) string {
	value := strings.TrimSpace(raw)
	value = strings.TrimPrefix(value, "user:")
	id, err := strconv.ParseUint(value, 10, 64)
	if err != nil || id == 0 {
		return ""
	}
	return strconv.FormatUint(id, 10)
}

// ParseWhatsAppUserContactID parses "whatsapp_user:<id>" contact IDs.
func ParseWhatsAppUserContactID(raw string) (string, bool) {
	value := strings.TrimSpace(raw)
	if !strings.HasPrefix(strings.ToLower(value), "whatsapp_user:") {
		return "", false
	}
	id := NormalizeWhatsAppID(value[len("whatsapp_user:"):])
	return id, id != ""
}
