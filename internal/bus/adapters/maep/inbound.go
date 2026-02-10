package maep

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	baseadapters "github.com/quailyquaily/mistermorph/internal/bus/adapters"
	maepproto "github.com/quailyquaily/mistermorph/maep"
)

type InboundAdapterOptions struct {
	Bus   *busruntime.Inproc
	Store baseadapters.InboundStore
	Now   func() time.Time
}

type InboundAdapter struct {
	flow *baseadapters.InboundFlow
}

func NewInboundAdapter(opts InboundAdapterOptions) (*InboundAdapter, error) {
	flow, err := baseadapters.NewInboundFlow(baseadapters.InboundFlowOptions{
		Bus:     opts.Bus,
		Store:   opts.Store,
		Channel: string(busruntime.ChannelMAEP),
		Now:     opts.Now,
	})
	if err != nil {
		return nil, err
	}
	return &InboundAdapter{flow: flow}, nil
}

func (a *InboundAdapter) HandleDataPush(ctx context.Context, event maepproto.DataPushEvent) (bool, error) {
	if a == nil || a.flow == nil {
		return false, fmt.Errorf("maep inbound adapter is not initialized")
	}
	if ctx == nil {
		return false, fmt.Errorf("context is required")
	}

	fromPeerID := strings.TrimSpace(event.FromPeerID)
	if fromPeerID == "" {
		return false, fmt.Errorf("from_peer_id is required")
	}
	topic := strings.TrimSpace(event.Topic)
	if topic == "" {
		return false, fmt.Errorf("topic is required")
	}
	idempotencyKey := strings.TrimSpace(event.IdempotencyKey)
	if idempotencyKey == "" {
		return false, fmt.Errorf("idempotency_key is required")
	}
	payloadBase64 := strings.TrimSpace(event.PayloadBase64)
	if payloadBase64 == "" {
		return false, fmt.Errorf("payload_base64 is required")
	}
	receivedAt := event.ReceivedAt.UTC()
	if receivedAt.IsZero() {
		return false, fmt.Errorf("received_at is required")
	}

	conversationKey, err := busruntime.BuildMAEPPeerConversationKey(fromPeerID)
	if err != nil {
		return false, err
	}
	msg := busruntime.BusMessage{
		Direction:       busruntime.DirectionInbound,
		Channel:         busruntime.ChannelMAEP,
		Topic:           topic,
		ConversationKey: conversationKey,
		ParticipantKey:  fromPeerID,
		IdempotencyKey:  idempotencyKey,
		CorrelationID:   "maep:" + idempotencyKey,
		PayloadBase64:   payloadBase64,
		CreatedAt:       receivedAt,
		Extensions: busruntime.MessageExtensions{
			ReplyTo:   strings.TrimSpace(event.ReplyTo),
			SessionID: strings.TrimSpace(event.SessionID),
		},
	}
	platformMessageID := fmt.Sprintf("%s:%s:%s", fromPeerID, topic, idempotencyKey)
	return a.flow.PublishValidatedInbound(ctx, platformMessageID, msg)
}

func EventFromBusMessage(msg busruntime.BusMessage) (maepproto.DataPushEvent, error) {
	if msg.Direction != busruntime.DirectionInbound {
		return maepproto.DataPushEvent{}, fmt.Errorf("direction must be inbound")
	}
	if msg.Channel != busruntime.ChannelMAEP {
		return maepproto.DataPushEvent{}, fmt.Errorf("channel must be maep")
	}
	peerID, err := resolvePeerID(msg)
	if err != nil {
		return maepproto.DataPushEvent{}, err
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(msg.PayloadBase64))
	if err != nil {
		return maepproto.DataPushEvent{}, fmt.Errorf("payload_base64 decode failed: %w", err)
	}
	env, err := msg.Envelope()
	if err != nil {
		return maepproto.DataPushEvent{}, err
	}
	sessionID := strings.TrimSpace(msg.Extensions.SessionID)
	if sessionID == "" {
		sessionID = strings.TrimSpace(env.SessionID)
	}
	replyTo := strings.TrimSpace(msg.Extensions.ReplyTo)
	if replyTo == "" {
		replyTo = strings.TrimSpace(env.ReplyTo)
	}
	receivedAt := msg.CreatedAt.UTC()
	if receivedAt.IsZero() {
		return maepproto.DataPushEvent{}, fmt.Errorf("created_at is required")
	}
	return maepproto.DataPushEvent{
		FromPeerID:     peerID,
		Topic:          msg.Topic,
		ContentType:    "application/json",
		PayloadBase64:  msg.PayloadBase64,
		PayloadBytes:   payloadBytes,
		IdempotencyKey: msg.IdempotencyKey,
		SessionID:      sessionID,
		ReplyTo:        replyTo,
		ReceivedAt:     receivedAt,
		Deduped:        false,
	}, nil
}

func resolvePeerID(msg busruntime.BusMessage) (string, error) {
	peerID := strings.TrimSpace(msg.ParticipantKey)
	if peerID != "" {
		return peerID, nil
	}
	const prefix = "maep:"
	if !strings.HasPrefix(msg.ConversationKey, prefix) {
		return "", fmt.Errorf("participant_key is required for maep message")
	}
	peerID = strings.TrimSpace(strings.TrimPrefix(msg.ConversationKey, prefix))
	if peerID == "" {
		return "", fmt.Errorf("participant_key is required for maep message")
	}
	return peerID, nil
}
