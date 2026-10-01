// Package accountdm adapts private messages of channels with one bound account (WeChat, WhatsApp)
// to and from the in-process bus. A conversation is "<channel>:<account>:<peer>", so rebinding to
// another account never mixes histories, and dedupe is per channel, account and message ID.
package accountdm

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	baseadapters "github.com/quailyquaily/mistermorph/internal/bus/adapters"
	"github.com/quailyquaily/mistermorph/internal/idempotency"
)

type InboundAdapterOptions struct {
	Channel busruntime.Channel
	Bus     *busruntime.Inproc
	Store   baseadapters.InboundStore
	Now     func() time.Time
}

// InboundMessage is one private message: AccountID is the bound account (bot or agent), PeerID
// the user it talks with.
type InboundMessage struct {
	AccountID        string
	PeerID           string
	MessageID        string
	SentAt           time.Time
	DisplayName      string
	Text             string
	ReplyToMessageID string
	// ImageAttachments are images the message carried, already saved to the file cache.
	ImageAttachments []busruntime.ImageAttachment
}

type InboundAdapter struct {
	channel busruntime.Channel
	flow    *baseadapters.InboundFlow
	store   baseadapters.InboundStore
	nowFn   func() time.Time
}

func NewInboundAdapter(opts InboundAdapterOptions) (*InboundAdapter, error) {
	if opts.Channel != busruntime.ChannelWeChat && opts.Channel != busruntime.ChannelWhatsApp {
		return nil, fmt.Errorf("channel %q is not a private-message channel", opts.Channel)
	}
	flow, err := baseadapters.NewInboundFlow(baseadapters.InboundFlowOptions{Bus: opts.Bus, Store: opts.Store, Channel: string(opts.Channel), Now: opts.Now})
	if err != nil {
		return nil, err
	}
	nowFn := opts.Now
	if nowFn == nil {
		nowFn = time.Now
	}
	return &InboundAdapter{channel: opts.Channel, flow: flow, store: opts.Store, nowFn: nowFn}, nil
}

// Seen reports whether a message already went through the inbox, without recording it: a replayed
// message with media is skipped before its media is downloaded again.
func (a *InboundAdapter) Seen(ctx context.Context, accountID, messageID string) (bool, error) {
	platformMessageID := strings.TrimSpace(accountID) + ":" + strings.TrimSpace(messageID)
	_, found, err := a.store.GetBusInboxRecord(ctx, string(a.channel), platformMessageID)
	return found, err
}

// FirstSeen records a message that does not go through the bus (one the channel cannot read) in
// the same inbox, and reports whether this is the first time, so a replay is answered only once.
func (a *InboundAdapter) FirstSeen(ctx context.Context, accountID, peerID, messageID string) (bool, error) {
	conversationKey, err := busruntime.BuildAccountConversationKey(a.channel, accountID, peerID)
	if err != nil {
		return false, err
	}
	platformMessageID := strings.TrimSpace(accountID) + ":" + strings.TrimSpace(messageID)
	if _, found, err := a.store.GetBusInboxRecord(ctx, string(a.channel), platformMessageID); err != nil || found {
		return false, err
	}
	return true, a.store.PutBusInboxRecord(ctx, contacts.BusInboxRecord{
		Channel: string(a.channel), PlatformMessageID: platformMessageID, ConversationKey: conversationKey, SeenAt: a.nowFn().UTC(),
	})
}

// HandleInboundMessage publishes one message and waits until the bus accepts it. It returns false
// for a message seen before, so a replay after a restart never starts a second task.
func (a *InboundAdapter) HandleInboundMessage(ctx context.Context, msg InboundMessage) (bool, error) {
	if a == nil || a.flow == nil {
		return false, fmt.Errorf("account dm inbound adapter is not initialized")
	}
	if ctx == nil {
		return false, fmt.Errorf("context is required")
	}
	conversationKey, err := busruntime.BuildAccountConversationKey(a.channel, msg.AccountID, msg.PeerID)
	if err != nil {
		return false, err
	}
	accountID, peerID := strings.TrimSpace(msg.AccountID), strings.TrimSpace(msg.PeerID)
	messageID := strings.TrimSpace(msg.MessageID)
	if messageID == "" || strings.ContainsAny(messageID, " \t\r\n") {
		return false, fmt.Errorf("message_id is invalid")
	}
	text := strings.TrimSpace(msg.Text)
	if text == "" {
		return false, fmt.Errorf("text is required")
	}
	sentAt := msg.SentAt.UTC()
	if sentAt.IsZero() {
		sentAt = a.nowFn().UTC()
	}
	sessionID, err := uuid.NewV7()
	if err != nil {
		return false, err
	}
	platformMessageID := accountID + ":" + messageID
	envelopeID := string(a.channel) + ":" + platformMessageID
	replyTo := strings.TrimSpace(msg.ReplyToMessageID)
	payload, err := busruntime.EncodeMessageEnvelope(busruntime.TopicChatMessage, busruntime.MessageEnvelope{
		MessageID: envelopeID, Text: text, SentAt: sentAt.Format(time.RFC3339), SessionID: sessionID.String(), ReplyTo: replyTo,
	})
	if err != nil {
		return false, err
	}
	message := busruntime.BusMessage{
		ID:              "bus_" + uuid.NewString(),
		Direction:       busruntime.DirectionInbound,
		Channel:         a.channel,
		Topic:           busruntime.TopicChatMessage,
		ConversationKey: conversationKey,
		ParticipantKey:  peerID,
		IdempotencyKey:  idempotency.MessageEnvelopeKey(envelopeID),
		CorrelationID:   envelopeID,
		PayloadBase64:   payload,
		CreatedAt:       sentAt,
		Extensions: busruntime.MessageExtensions{
			PlatformMessageID: platformMessageID,
			ReplyTo:           replyTo,
			SessionID:         sessionID.String(),
			ChatType:          "private",
			FromDisplayName:   strings.TrimSpace(msg.DisplayName),
			FromUserRef:       peerID,
			EventID:           messageID,
			ImageAttachments:  msg.ImageAttachments,
		},
	}
	return a.flow.PublishValidatedInboundAndWait(ctx, platformMessageID, message)
}

// InboundMessageFromBusMessage reads back what HandleInboundMessage published.
func InboundMessageFromBusMessage(msg busruntime.BusMessage) (InboundMessage, error) {
	if msg.Direction != busruntime.DirectionInbound {
		return InboundMessage{}, fmt.Errorf("direction must be inbound")
	}
	accountID, peerID, err := busruntime.ParseAccountConversationKey(msg.Channel, msg.ConversationKey)
	if err != nil {
		return InboundMessage{}, err
	}
	envelope, err := msg.Envelope()
	if err != nil {
		return InboundMessage{}, err
	}
	sentAt, err := time.Parse(time.RFC3339, strings.TrimSpace(envelope.SentAt))
	if err != nil {
		return InboundMessage{}, fmt.Errorf("sent_at is invalid")
	}
	messageID := strings.TrimSpace(msg.Extensions.EventID)
	if messageID == "" {
		return InboundMessage{}, fmt.Errorf("message_id is required")
	}
	return InboundMessage{
		AccountID: accountID, PeerID: peerID, MessageID: messageID, SentAt: sentAt.UTC(),
		DisplayName: strings.TrimSpace(msg.Extensions.FromDisplayName), Text: strings.TrimSpace(envelope.Text),
		ReplyToMessageID: strings.TrimSpace(msg.Extensions.ReplyTo),
		ImageAttachments: msg.Extensions.ImageAttachments,
	}, nil
}

// SendTextFunc sends text to peerID from accountID, quoting replyTo when it is set.
type SendTextFunc func(ctx context.Context, accountID, peerID, text, replyTo string) error

type DeliveryAdapter struct {
	channel  busruntime.Channel
	sendText SendTextFunc
}

func NewDeliveryAdapter(channel busruntime.Channel, sendText SendTextFunc) (*DeliveryAdapter, error) {
	if sendText == nil {
		return nil, fmt.Errorf("send text func is required")
	}
	return &DeliveryAdapter{channel: channel, sendText: sendText}, nil
}

// Deliver sends an outbound bus message to its peer.
func (a *DeliveryAdapter) Deliver(ctx context.Context, msg busruntime.BusMessage) error {
	if msg.Direction != busruntime.DirectionOutbound || msg.Channel != a.channel {
		return fmt.Errorf("not an outbound %s message", a.channel)
	}
	accountID, peerID, err := busruntime.ParseAccountConversationKey(a.channel, msg.ConversationKey)
	if err != nil {
		return err
	}
	envelope, err := msg.Envelope()
	if err != nil {
		return err
	}
	text := strings.TrimSpace(envelope.Text)
	if text == "" {
		return fmt.Errorf("%s outbound text is empty", a.channel)
	}
	replyTo := strings.TrimSpace(msg.Extensions.ReplyTo)
	if replyTo == "" {
		replyTo = strings.TrimSpace(envelope.ReplyTo)
	}
	return a.sendText(ctx, accountID, peerID, text, replyTo)
}

// NewOutbound builds an outbound bus message to peerID of accountID.
func NewOutbound(channel busruntime.Channel, accountID, peerID, text, replyTo, correlationID string) (busruntime.BusMessage, error) {
	conversationKey, err := busruntime.BuildAccountConversationKey(channel, accountID, peerID)
	if err != nil {
		return busruntime.BusMessage{}, err
	}
	text = strings.TrimSpace(text)
	if text == "" {
		return busruntime.BusMessage{}, fmt.Errorf("text is required")
	}
	messageID := string(channel) + ":out:" + uuid.NewString()
	now := time.Now().UTC()
	session, err := uuid.NewV7()
	if err != nil {
		return busruntime.BusMessage{}, err
	}
	replyTo = strings.TrimSpace(replyTo)
	payload, err := busruntime.EncodeMessageEnvelope(busruntime.TopicChatMessage, busruntime.MessageEnvelope{
		MessageID: messageID, Text: text, SentAt: now.Format(time.RFC3339), SessionID: session.String(), ReplyTo: replyTo,
	})
	if err != nil {
		return busruntime.BusMessage{}, err
	}
	if strings.TrimSpace(correlationID) == "" {
		correlationID = messageID
	}
	return busruntime.BusMessage{
		ID: "bus_" + uuid.NewString(), Direction: busruntime.DirectionOutbound, Channel: channel,
		Topic: busruntime.TopicChatMessage, ConversationKey: conversationKey, ParticipantKey: strings.TrimSpace(peerID),
		IdempotencyKey: idempotency.MessageEnvelopeKey(messageID), CorrelationID: correlationID, PayloadBase64: payload, CreatedAt: now,
		Extensions: busruntime.MessageExtensions{SessionID: session.String(), ReplyTo: replyTo},
	}, nil
}
