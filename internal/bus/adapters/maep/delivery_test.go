package maep

import (
	"context"
	"testing"
	"time"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	maepproto "github.com/quailyquaily/mistermorph/maep"
)

type mockDataPusher struct {
	peerID string
	req    maepproto.DataPushRequest
	calls  int
}

func (m *mockDataPusher) PushData(ctx context.Context, peerID string, addresses []string, req maepproto.DataPushRequest, notification bool) (maepproto.DataPushResult, error) {
	m.peerID = peerID
	m.req = req
	m.calls++
	return maepproto.DataPushResult{Accepted: true, Deduped: false}, nil
}

func TestDeliveryAdapterDeliver(t *testing.T) {
	t.Parallel()

	mock := &mockDataPusher{}
	adapter, err := NewDeliveryAdapter(DeliveryAdapterOptions{Node: mock})
	if err != nil {
		t.Fatalf("NewDeliveryAdapter() error = %v", err)
	}
	payloadBase64, err := busruntime.EncodeMessageEnvelope(busruntime.TopicDMReplyV1, busruntime.MessageEnvelope{
		MessageID: "msg_3001",
		Text:      "hi",
		SentAt:    "2026-02-08T00:00:00Z",
		SessionID: "0194e9d5-2f8f-7000-8000-000000000001",
	})
	if err != nil {
		t.Fatalf("EncodeMessageEnvelope() error = %v", err)
	}
	msg := busruntime.BusMessage{
		Direction:       busruntime.DirectionOutbound,
		Channel:         busruntime.ChannelMAEP,
		Topic:           busruntime.TopicDMReplyV1,
		ConversationKey: "maep:12D3KooWpeerC",
		ParticipantKey:  "12D3KooWpeerC",
		IdempotencyKey:  "msg:msg_3001",
		CorrelationID:   "corr_2",
		PayloadBase64:   payloadBase64,
		CreatedAt:       time.Now().UTC(),
	}
	accepted, deduped, err := adapter.Deliver(context.Background(), msg)
	if err != nil {
		t.Fatalf("Deliver() error = %v", err)
	}
	if !accepted {
		t.Fatalf("accepted mismatch: got %v want true", accepted)
	}
	if deduped {
		t.Fatalf("deduped mismatch: got %v want false", deduped)
	}
	if mock.calls != 1 {
		t.Fatalf("PushData() calls mismatch: got %d want 1", mock.calls)
	}
	if mock.peerID != msg.ParticipantKey {
		t.Fatalf("peer_id mismatch: got %q want %q", mock.peerID, msg.ParticipantKey)
	}
	if mock.req.Topic != msg.Topic {
		t.Fatalf("topic mismatch: got %q want %q", mock.req.Topic, msg.Topic)
	}
	if mock.req.IdempotencyKey != msg.IdempotencyKey {
		t.Fatalf("idempotency_key mismatch: got %q want %q", mock.req.IdempotencyKey, msg.IdempotencyKey)
	}
}
