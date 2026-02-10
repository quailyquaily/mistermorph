package maep

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	maepproto "github.com/quailyquaily/mistermorph/maep"
)

func TestInboundAdapterHandleDataPush(t *testing.T) {
	t.Parallel()

	logger := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug}))
	bus, err := busruntime.NewInproc(busruntime.InprocOptions{MaxInFlight: 4, Logger: logger})
	if err != nil {
		t.Fatalf("NewInproc() error = %v", err)
	}
	defer bus.Close()

	store := contacts.NewFileStore(t.TempDir())
	adapter, err := NewInboundAdapter(InboundAdapterOptions{
		Bus:   bus,
		Store: store,
	})
	if err != nil {
		t.Fatalf("NewInboundAdapter() error = %v", err)
	}

	delivered := make(chan busruntime.BusMessage, 1)
	if err := bus.Subscribe(busruntime.TopicChatMessage, func(ctx context.Context, msg busruntime.BusMessage) error {
		delivered <- msg
		return nil
	}); err != nil {
		t.Fatalf("Subscribe() error = %v", err)
	}

	payloadBase64, err := busruntime.EncodeMessageEnvelope(busruntime.TopicChatMessage, busruntime.MessageEnvelope{
		MessageID: "msg_1001",
		Text:      "hello",
		SentAt:    "2026-02-08T00:00:00Z",
		SessionID: "0194e9d5-2f8f-7000-8000-000000000001",
	})
	if err != nil {
		t.Fatalf("EncodeMessageEnvelope() error = %v", err)
	}
	event := maepproto.DataPushEvent{
		FromPeerID:     "12D3KooWpeerA",
		Topic:          busruntime.TopicChatMessage,
		ContentType:    "application/json",
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "msg:msg_1001",
		ReceivedAt:     time.Now().UTC(),
	}
	accepted, err := adapter.HandleDataPush(context.Background(), event)
	if err != nil {
		t.Fatalf("HandleDataPush() error = %v", err)
	}
	if !accepted {
		t.Fatalf("HandleDataPush() accepted=false, want true")
	}

	select {
	case msg := <-delivered:
		if msg.Channel != busruntime.ChannelMAEP {
			t.Fatalf("channel mismatch: got %s want %s", msg.Channel, busruntime.ChannelMAEP)
		}
		if msg.ParticipantKey != event.FromPeerID {
			t.Fatalf("participant_key mismatch: got %q want %q", msg.ParticipantKey, event.FromPeerID)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("message not delivered")
	}

	accepted, err = adapter.HandleDataPush(context.Background(), event)
	if err != nil {
		t.Fatalf("HandleDataPush(second) error = %v", err)
	}
	if accepted {
		t.Fatalf("HandleDataPush(second) accepted=true, want false")
	}
}

func TestEventFromBusMessage(t *testing.T) {
	t.Parallel()

	payloadBase64, err := busruntime.EncodeMessageEnvelope(busruntime.TopicDMReplyV1, busruntime.MessageEnvelope{
		MessageID: "msg_2001",
		Text:      "reply",
		SentAt:    "2026-02-08T00:00:00Z",
		SessionID: "0194e9d5-2f8f-7000-8000-000000000001",
	})
	if err != nil {
		t.Fatalf("EncodeMessageEnvelope() error = %v", err)
	}
	msg := busruntime.BusMessage{
		Direction:       busruntime.DirectionInbound,
		Channel:         busruntime.ChannelMAEP,
		Topic:           busruntime.TopicDMReplyV1,
		ConversationKey: "maep:12D3KooWpeerB",
		ParticipantKey:  "12D3KooWpeerB",
		IdempotencyKey:  "msg:msg_2001",
		CorrelationID:   "corr_1",
		PayloadBase64:   payloadBase64,
		CreatedAt:       time.Now().UTC(),
	}
	event, err := EventFromBusMessage(msg)
	if err != nil {
		t.Fatalf("EventFromBusMessage() error = %v", err)
	}
	if event.FromPeerID != msg.ParticipantKey {
		t.Fatalf("from_peer_id mismatch: got %q want %q", event.FromPeerID, msg.ParticipantKey)
	}
	if event.Topic != msg.Topic {
		t.Fatalf("topic mismatch: got %q want %q", event.Topic, msg.Topic)
	}
}
