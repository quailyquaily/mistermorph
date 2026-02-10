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
	ChannelTelegram = channels.Telegram
	ChannelMAEP     = channels.MAEP
)

type Contact struct {
	ContactID         string     `json:"contact_id"`
	Kind              Kind       `json:"kind"`
	Status            Status     `json:"status"`
	Channel           string     `json:"channel"`
	ContactNickname   string     `json:"nickname,omitempty"`
	TGUsername        string     `json:"tg_username,omitempty"`
	PrivateChatID     int64      `json:"private_chat_id,omitempty"`
	GroupChatIDs      []int64    `json:"group_chat_ids,omitempty"`
	MAEPNodeID        string     `json:"maep_node_id,omitempty"`
	MAEPDialAddress   string     `json:"maep_dial_address,omitempty"`
	PersonaBrief      string     `json:"persona_brief,omitempty"`
	TopicPreferences  []string   `json:"topic_preferences,omitempty"`
	CooldownUntil     *time.Time `json:"cooldown_until,omitempty"`
	LastInteractionAt *time.Time `json:"last_interaction_at,omitempty"`
}

type ShareDecision struct {
	ContactID      string `json:"contact_id"`
	PeerID         string `json:"peer_id,omitempty"`
	ItemID         string `json:"item_id"`
	Topic          string `json:"topic"`
	ContentType    string `json:"content_type"`
	PayloadBase64  string `json:"payload_base64"`
	IdempotencyKey string `json:"idempotency_key"`
	SourceChatID   int64  `json:"source_chat_id,omitempty"`
	SourceChatType string `json:"source_chat_type,omitempty"`
}

type ShareOutcome struct {
	ContactID      string    `json:"contact_id"`
	PeerID         string    `json:"peer_id,omitempty"`
	ItemID         string    `json:"item_id"`
	IdempotencyKey string    `json:"idempotency_key"`
	Accepted       bool      `json:"accepted"`
	Deduped        bool      `json:"deduped"`
	Error          string    `json:"error,omitempty"`
	SentAt         time.Time `json:"sent_at"`
}
