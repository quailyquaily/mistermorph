// Package discord adapts Discord messages to and from the in-process bus.
package discord

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	baseadapters "github.com/quailyquaily/mistermorph/internal/bus/adapters"
	"github.com/quailyquaily/mistermorph/internal/idempotency"
)

// Chat types: a DM is private; a server channel or thread is a group.
const (
	ChatTypePrivate = "private"
	ChatTypeGroup   = "group"
)

type InboundAdapterOptions struct {
	Bus   *busruntime.Inproc
	Store baseadapters.InboundStore
	Now   func() time.Time
}

type InboundMessage struct {
	ChannelID        string
	GuildID          string
	MessageID        string
	SentAt           time.Time
	ChatType         string
	UserID           string
	Username         string
	DisplayName      string
	FromIsAgent      bool
	Text             string
	ReplyToMessageID string
	MentionUserIDs   []string
	ImageAttachments []busruntime.ImageAttachment
}

type InboundAdapter struct {
	flow  *baseadapters.InboundFlow
	nowFn func() time.Time
}

func NewInboundAdapter(opts InboundAdapterOptions) (*InboundAdapter, error) {
	flow, err := baseadapters.NewInboundFlow(baseadapters.InboundFlowOptions{
		Bus:     opts.Bus,
		Store:   opts.Store,
		Channel: string(busruntime.ChannelDiscord),
		Now:     opts.Now,
	})
	if err != nil {
		return nil, err
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &InboundAdapter{flow: flow, nowFn: nowFn}, nil
}

// HandleInboundMessage publishes one Discord message. It returns false when the message was seen
// before (a Gateway resume replays events), so it never starts a second task.
func (a *InboundAdapter) HandleInboundMessage(ctx context.Context, msg InboundMessage) (bool, error) {
	if a == nil || a.flow == nil {
		return false, fmt.Errorf("discord inbound adapter is not initialized")
	}
	if ctx == nil {
		return false, fmt.Errorf("context is required")
	}
	channelID, err := NormalizeSnowflake("channel_id", msg.ChannelID)
	if err != nil {
		return false, err
	}
	messageID, err := NormalizeSnowflake("message_id", msg.MessageID)
	if err != nil {
		return false, err
	}
	userID, err := NormalizeSnowflake("user_id", msg.UserID)
	if err != nil {
		return false, err
	}
	guildID := ""
	if strings.TrimSpace(msg.GuildID) != "" {
		if guildID, err = NormalizeSnowflake("guild_id", msg.GuildID); err != nil {
			return false, err
		}
	}
	chatType, err := normalizeChatType(msg.ChatType)
	if err != nil {
		return false, err
	}
	text := strings.TrimSpace(msg.Text)
	if text == "" {
		return false, fmt.Errorf("text is required")
	}
	replyTo := ""
	if strings.TrimSpace(msg.ReplyToMessageID) != "" {
		if replyTo, err = NormalizeSnowflake("reply_to_message_id", msg.ReplyToMessageID); err != nil {
			return false, err
		}
	}
	mentions, err := normalizeSnowflakes("mention_user_id", msg.MentionUserIDs)
	if err != nil {
		return false, err
	}
	imageAttachments, imagePaths, err := baseadapters.NormalizeImageInputs(msg.ImageAttachments, nil)
	if err != nil {
		return false, err
	}
	sentAt := msg.SentAt.UTC()
	if sentAt.IsZero() {
		sentAt = a.nowFn().UTC()
	}
	sessionID, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	platformMessageID := channelID + ":" + messageID
	envelopeMessageID := "discord:" + platformMessageID
	payload, err := busruntime.EncodeMessageEnvelope(busruntime.TopicChatMessage, busruntime.MessageEnvelope{
		MessageID: envelopeMessageID,
		Text:      text,
		SentAt:    sentAt.Format(time.RFC3339),
		SessionID: sessionID.String(),
		ReplyTo:   replyTo,
	})
	if err != nil {
		return false, err
	}
	conversationKey, err := busruntime.BuildDiscordConversationKey(channelID)
	if err != nil {
		return false, err
	}
	message := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionInbound,
		Channel:         busruntime.ChannelDiscord,
		Topic:           busruntime.TopicChatMessage,
		ConversationKey: conversationKey,
		ParticipantKey:  userID,
		IdempotencyKey:  idempotency.MessageEnvelopeKey(envelopeMessageID),
		CorrelationID:   "discord:" + platformMessageID,
		PayloadBase64:   payload,
		CreatedAt:       sentAt,
		Extensions: busruntime.MessageExtensions{
			PlatformMessageID: platformMessageID,
			ReplyTo:           replyTo,
			SessionID:         sessionID.String(),
			ChatType:          chatType,
			FromUsername:      strings.TrimSpace(msg.Username),
			FromDisplayName:   strings.TrimSpace(msg.DisplayName),
			FromIsAgent:       msg.FromIsAgent,
			GuildID:           guildID,
			ChannelID:         channelID,
			FromUserRef:       userID,
			EventID:           messageID,
			MentionUsers:      mentions,
			ImagePaths:        imagePaths,
			ImageAttachments:  imageAttachments,
		},
	}
	return a.flow.PublishValidatedInboundAndWait(ctx, platformMessageID, message)
}

// InboundMessageFromBusMessage reads back what HandleInboundMessage published.
func InboundMessageFromBusMessage(msg busruntime.BusMessage) (InboundMessage, error) {
	if msg.Direction != busruntime.DirectionInbound {
		return InboundMessage{}, fmt.Errorf("direction must be inbound")
	}
	if msg.Channel != busruntime.ChannelDiscord {
		return InboundMessage{}, fmt.Errorf("channel must be discord")
	}
	channelID, err := busruntime.ParseDiscordConversationKey(msg.ConversationKey)
	if err != nil {
		return InboundMessage{}, err
	}
	platformChannelID, messageID, err := parsePlatformMessageID(msg.Extensions.PlatformMessageID)
	if err != nil {
		return InboundMessage{}, err
	}
	if platformChannelID != channelID {
		return InboundMessage{}, fmt.Errorf("platform_message_id does not match conversation_key")
	}
	envelope, err := msg.Envelope()
	if err != nil {
		return InboundMessage{}, err
	}
	sentAt, err := time.Parse(time.RFC3339, strings.TrimSpace(envelope.SentAt))
	if err != nil {
		return InboundMessage{}, fmt.Errorf("sent_at is invalid")
	}
	chatType, err := normalizeChatType(msg.Extensions.ChatType)
	if err != nil {
		return InboundMessage{}, err
	}
	userID, err := NormalizeSnowflake("user_id", firstNonEmpty(msg.Extensions.FromUserRef, msg.ParticipantKey))
	if err != nil {
		return InboundMessage{}, err
	}
	mentions, err := normalizeSnowflakes("mention_user_id", msg.Extensions.MentionUsers)
	if err != nil {
		return InboundMessage{}, err
	}
	imageAttachments, _, err := baseadapters.NormalizeImageInputs(msg.Extensions.ImageAttachments, msg.Extensions.ImagePaths)
	if err != nil {
		return InboundMessage{}, err
	}
	return InboundMessage{
		ChannelID:        channelID,
		GuildID:          strings.TrimSpace(msg.Extensions.GuildID),
		MessageID:        messageID,
		SentAt:           sentAt.UTC(),
		ChatType:         chatType,
		UserID:           userID,
		Username:         strings.TrimSpace(msg.Extensions.FromUsername),
		DisplayName:      strings.TrimSpace(msg.Extensions.FromDisplayName),
		FromIsAgent:      msg.Extensions.FromIsAgent,
		Text:             strings.TrimSpace(envelope.Text),
		ReplyToMessageID: strings.TrimSpace(msg.Extensions.ReplyTo),
		MentionUserIDs:   mentions,
		ImageAttachments: imageAttachments,
	}, nil
}

func parsePlatformMessageID(value string) (string, string, error) {
	parts := strings.Split(strings.TrimSpace(value), ":")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("platform_message_id is invalid")
	}
	channelID, err := NormalizeSnowflake("channel_id", parts[0])
	if err != nil {
		return "", "", err
	}
	messageID, err := NormalizeSnowflake("message_id", parts[1])
	if err != nil {
		return "", "", err
	}
	return channelID, messageID, nil
}

// NormalizeSnowflake checks a Discord ID: a positive 64-bit integer written in decimal.
func NormalizeSnowflake(field, value string) (string, error) {
	id, err := strconv.ParseUint(strings.TrimSpace(value), 10, 64)
	if err != nil || id == 0 {
		return "", fmt.Errorf("%s is invalid", field)
	}
	return strconv.FormatUint(id, 10), nil
}

func normalizeSnowflakes(field string, values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, nil
	}
	out := make([]string, 0, len(values))
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		id, err := NormalizeSnowflake(field, value)
		if err != nil {
			return nil, err
		}
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out, nil
}

func normalizeChatType(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if value != ChatTypePrivate && value != ChatTypeGroup {
		return "", fmt.Errorf("chat_type must be private or group")
	}
	return value, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value = strings.TrimSpace(value); value != "" {
			return value
		}
	}
	return ""
}
