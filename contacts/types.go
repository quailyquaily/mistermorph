package contacts

import (
	"time"

	"github.com/quailyquaily/mistermorph/internal/channels"
)

type Kind string

const (
	KindHuman Kind = "human"
	KindAgent Kind = "agent"
)

type Status string

const (
	StatusActive   Status = "active"
	StatusInactive Status = "inactive"
)

const (
	ChannelConsole  = channels.Console
	ChannelTelegram = channels.Telegram
	ChannelSlack    = channels.Slack
	ChannelLine     = channels.Line
	ChannelLark     = channels.Lark
	ChannelMixin    = channels.Mixin
	ChannelDiscord  = channels.Discord
	ChannelWeChat   = channels.WeChat
	ChannelWhatsApp = channels.WhatsApp
	ShareTopic      = "chat.message"
)

type Contact struct {
	ContactID           string     `json:"contact_id"`
	Synthetic           bool       `json:"-" yaml:"-"`
	Kind                Kind       `json:"kind"`
	Paired              bool       `json:"paired,omitempty"`
	Channel             string     `json:"channel"`
	ContactNickname     string     `json:"nickname,omitempty"`
	TGUsername          string     `json:"tg_username,omitempty"`
	TGUserID            int64      `json:"tg_user_id,omitempty"`
	TGPrivateChatID     int64      `json:"tg_private_chat_id,omitempty"`
	TGGroupChatIDs      []int64    `json:"tg_group_chat_ids,omitempty"`
	LineUserID          string     `json:"line_user_id,omitempty"`
	LineChatIDs         []string   `json:"line_chat_ids,omitempty"`
	LarkOpenID          string     `json:"lark_open_id,omitempty"`
	LarkChatIDs         []string   `json:"lark_chat_ids,omitempty"`
	MixinUserID         string     `json:"mixin_user_id,omitempty"`
	MixinIdentityNumber string     `json:"mixin_identity_number,omitempty"`
	MixinChatIDs        []string   `json:"mixin_chat_ids,omitempty"`
	DiscordUserID       string     `json:"discord_user_id,omitempty"`
	DiscordDMChannelID  string     `json:"discord_dm_channel_id,omitempty"`
	DiscordChannelIDs   []string   `json:"discord_channel_ids,omitempty"`
	WeChatUserID        string     `json:"wechat_user_id,omitempty"`
	WhatsAppUserID      string     `json:"whatsapp_user_id,omitempty"`
	SlackTeamID         string     `json:"slack_team_id,omitempty"`
	SlackUserID         string     `json:"slack_user_id,omitempty"`
	SlackDMChannelID    string     `json:"slack_dm_channel_id,omitempty"`
	SlackChannelIDs     []string   `json:"slack_channel_ids,omitempty"`
	PersonaBrief        string     `json:"persona_brief,omitempty"`
	TopicPreferences    []string   `json:"topic_preferences,omitempty"`
	CooldownUntil       *time.Time `json:"cooldown_until,omitempty"`
	LastInteractionAt   *time.Time `json:"last_interaction_at,omitempty"`
}

type ShareDecision struct {
	ContactID           string   `json:"contact_id"`
	RecipientContactIDs []string `json:"recipient_contact_ids,omitempty"`
	ChatID              string   `json:"chat_id,omitempty"`
	PeerID              string   `json:"peer_id,omitempty"`
	ItemID              string   `json:"item_id"`
	ContentType         string   `json:"content_type"`
	PayloadBase64       string   `json:"payload_base64"`
	IdempotencyKey      string   `json:"idempotency_key"`
	// File is a local file to send, with the payload text as its caption.
	File *ShareFile `json:"file,omitempty"`
}

// ShareFile describes a validated local file to send. Delivery records keep this metadata, never
// the file's bytes.
type ShareFile struct {
	// Path is the file's resolved absolute path.
	Path string `json:"path"`
	// Filename is the display filename the recipient sees.
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
	SHA256   string `json:"sha256"`
}

type ShareOutcome struct {
	ContactID      string `json:"contact_id"`
	PeerID         string `json:"peer_id,omitempty"`
	ItemID         string `json:"item_id"`
	IdempotencyKey string `json:"idempotency_key"`
	Accepted       bool   `json:"accepted"`
	Deduped        bool   `json:"deduped"`
	Error          string `json:"error,omitempty"`
	// Partial means a file was delivered but the text that follows it failed; Error says why.
	Partial bool      `json:"partial,omitempty"`
	SentAt  time.Time `json:"sent_at"`
}
