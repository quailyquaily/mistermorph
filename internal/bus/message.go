package bus

import (
	"fmt"
	"regexp"
	"strings"
	"time"
)

type Direction string

const (
	DirectionInbound  Direction = "inbound"
	DirectionOutbound Direction = "outbound"
)

type Channel string

const (
	ChannelTelegram Channel = "telegram"
	ChannelSlack    Channel = "slack"
	ChannelDiscord  Channel = "discord"
	ChannelMAEP     Channel = "maep"
)

type Source string

const (
	SourceTelegram Source = "telegram"
	SourceSlack    Source = "slack"
	SourceDiscord  Source = "discord"
	SourceMAEP     Source = "maep"
	SourceSystem   Source = "system"
)

type BusMessage struct {
	ID              string            `json:"id"`
	Direction       Direction         `json:"direction"`
	Source          Source            `json:"source"`
	Channel         Channel           `json:"channel"`
	Topic           string            `json:"topic"`
	ConversationKey string            `json:"conversation_key"`
	ParticipantKey  string            `json:"participant_key"`
	IdempotencyKey  string            `json:"idempotency_key"`
	CorrelationID   string            `json:"correlation_id"`
	CausationID     string            `json:"causation_id,omitempty"`
	ContentType     string            `json:"content_type"`
	PayloadBase64   string            `json:"payload_base64"`
	CreatedAt       time.Time         `json:"created_at"`
	Metadata        map[string]string `json:"metadata,omitempty"`
}

var topicPattern = regexp.MustCompile(`^[a-z0-9]+(?:\.[a-z0-9_]+)*$`)

func (m BusMessage) Validate() error {
	if err := validateRequiredCanonicalString("id", m.ID); err != nil {
		return err
	}
	switch m.Direction {
	case DirectionInbound, DirectionOutbound:
	default:
		return fmt.Errorf("direction must be inbound|outbound")
	}

	switch m.Source {
	case SourceTelegram, SourceSlack, SourceDiscord, SourceMAEP, SourceSystem:
	default:
		return fmt.Errorf("source is invalid")
	}

	switch m.Channel {
	case ChannelTelegram, ChannelSlack, ChannelDiscord, ChannelMAEP:
	default:
		return fmt.Errorf("channel is invalid")
	}

	if err := validateRequiredCanonicalString("topic", m.Topic); err != nil {
		return err
	}
	if !topicPattern.MatchString(m.Topic) {
		return fmt.Errorf("topic is invalid")
	}
	if err := validateRequiredCanonicalString("conversation_key", m.ConversationKey); err != nil {
		return err
	}
	if err := validateRequiredCanonicalString("participant_key", m.ParticipantKey); err != nil {
		return err
	}
	if err := validateRequiredCanonicalString("idempotency_key", m.IdempotencyKey); err != nil {
		return err
	}
	if err := validateRequiredCanonicalString("correlation_id", m.CorrelationID); err != nil {
		return err
	}
	if m.CausationID != "" {
		if err := validateOptionalCanonicalString("causation_id", m.CausationID); err != nil {
			return err
		}
	}

	if err := validateRequiredCanonicalString("content_type", m.ContentType); err != nil {
		return err
	}
	if !isJSONContentType(m.ContentType) {
		return fmt.Errorf("content_type must start with application/json")
	}

	if err := validateRequiredCanonicalString("payload_base64", m.PayloadBase64); err != nil {
		return err
	}
	if m.CreatedAt.IsZero() {
		return fmt.Errorf("created_at is required")
	}

	if _, err := DecodeMessageEnvelope(m.Topic, m.PayloadBase64); err != nil {
		return err
	}

	for k, v := range m.Metadata {
		if err := validateRequiredCanonicalString("metadata key", k); err != nil {
			return err
		}
		if err := validateOptionalCanonicalString("metadata value", v); err != nil {
			return err
		}
	}

	return nil
}

func (m BusMessage) Envelope() (MessageEnvelope, error) {
	return DecodeMessageEnvelope(m.Topic, m.PayloadBase64)
}

func isJSONContentType(contentType string) bool {
	return contentType == "application/json" || strings.HasPrefix(contentType, "application/json;")
}
