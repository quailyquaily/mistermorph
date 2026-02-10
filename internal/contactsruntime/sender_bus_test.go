package contactsruntime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	maepbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/maep"
	telegrambus "github.com/quailyquaily/mistermorph/internal/bus/adapters/telegram"
	"github.com/quailyquaily/mistermorph/maep"
)

func TestRoutingSenderSendTelegramViaBus(t *testing.T) {
	ctx := context.Background()

	var (
		mu        sync.Mutex
		gotTarget any
		gotText   string
	)
	sendText := func(ctx context.Context, target any, text string) error {
		mu.Lock()
		defer mu.Unlock()
		gotTarget = target
		gotText = text
		return nil
	}

	sender := newRoutingSenderForBusTest(t, sendText, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello telegram")
	accepted, deduped, err := sender.Send(ctx, contacts.Contact{
		ContactID:     "tg:12345",
		Kind:          contacts.KindHuman,
		Status:        contacts.StatusActive,
		Channel:       contacts.ChannelTelegram,
		PrivateChatID: 12345,
	}, contacts.ShareDecision{
		ContactID:      "tg:12345",
		ItemID:         "cand_1",
		Topic:          busruntime.TopicShareProactiveV1,
		ContentType:    contentType,
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "manual:tg:1",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if !accepted {
		t.Fatalf("accepted mismatch: got %v want true", accepted)
	}
	if deduped {
		t.Fatalf("deduped mismatch: got %v want false", deduped)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotText != "hello telegram" {
		t.Fatalf("text mismatch: got %q want %q", gotText, "hello telegram")
	}
	if gotTarget != int64(12345) {
		t.Fatalf("target mismatch: got %#v want %d", gotTarget, int64(12345))
	}
}

func TestRoutingSenderSendMAEPViaBus(t *testing.T) {
	ctx := context.Background()

	pusher := &mockDataPusher{
		result: maep.DataPushResult{
			Accepted: true,
			Deduped:  true,
		},
	}
	sendText := func(ctx context.Context, target any, text string) error {
		return fmt.Errorf("unexpected telegram send: target=%v text=%q", target, text)
	}
	sender := newRoutingSenderForBusTest(t, sendText, pusher)

	contentType, payloadBase64 := testEnvelopePayload(t, "hello maep")
	accepted, deduped, err := sender.Send(ctx, contacts.Contact{
		ContactID:  "maep:12D3KooWTestPeer",
		Kind:       contacts.KindAgent,
		Status:     contacts.StatusActive,
		Channel:    contacts.ChannelMAEP,
		MAEPNodeID: "maep:12D3KooWTestPeer",
	}, contacts.ShareDecision{
		ContactID:      "maep:12D3KooWTestPeer",
		ItemID:         "cand_2",
		Topic:          busruntime.TopicShareProactiveV1,
		ContentType:    contentType,
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "manual:maep:1",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	if !accepted {
		t.Fatalf("accepted mismatch: got %v want true", accepted)
	}
	if !deduped {
		t.Fatalf("deduped mismatch: got %v want true", deduped)
	}
	pusher.mu.Lock()
	defer pusher.mu.Unlock()
	if pusher.calls != 1 {
		t.Fatalf("PushData calls mismatch: got %d want 1", pusher.calls)
	}
	if pusher.peerID != "12D3KooWTestPeer" {
		t.Fatalf("peer_id mismatch: got %q want %q", pusher.peerID, "12D3KooWTestPeer")
	}
	if pusher.req.Topic != busruntime.TopicShareProactiveV1 {
		t.Fatalf("topic mismatch: got %q want %q", pusher.req.Topic, busruntime.TopicShareProactiveV1)
	}
	if pusher.req.IdempotencyKey != "manual:maep:1" {
		t.Fatalf("idempotency_key mismatch: got %q want %q", pusher.req.IdempotencyKey, "manual:maep:1")
	}
}

func TestRoutingSenderSendFailsWithoutIdempotencyKey(t *testing.T) {
	ctx := context.Background()

	sender := newRoutingSenderForBusTest(t, func(ctx context.Context, target any, text string) error {
		return nil
	}, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello")
	_, _, err := sender.Send(ctx, contacts.Contact{
		ContactID:     "tg:12345",
		Kind:          contacts.KindHuman,
		Status:        contacts.StatusActive,
		Channel:       contacts.ChannelTelegram,
		PrivateChatID: 12345,
	}, contacts.ShareDecision{
		ContactID:     "tg:12345",
		ItemID:        "cand_3",
		Topic:         busruntime.TopicShareProactiveV1,
		ContentType:   contentType,
		PayloadBase64: payloadBase64,
	})
	if err == nil {
		t.Fatalf("Send() expected error for empty idempotency_key")
	}
	if got := err.Error(); got != "idempotency_key is required" {
		t.Fatalf("Send() error mismatch: got %q want %q", got, "idempotency_key is required")
	}
}

func TestRoutingSenderSendHumanWithUsernameTargetFails(t *testing.T) {
	ctx := context.Background()

	calls := 0
	sender := newRoutingSenderForBusTest(t, func(ctx context.Context, target any, text string) error {
		calls++
		return nil
	}, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello")
	_, _, err := sender.Send(ctx, contacts.Contact{
		ContactID:  "tg:@alice",
		Kind:       contacts.KindHuman,
		Status:     contacts.StatusActive,
		Channel:    contacts.ChannelTelegram,
		TGUsername: "alice",
	}, contacts.ShareDecision{
		ContactID:      "tg:@alice",
		ItemID:         "cand_4",
		Topic:          busruntime.TopicShareProactiveV1,
		ContentType:    contentType,
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "manual:tg:@alice",
	})
	if err == nil {
		t.Fatalf("Send() expected error for tg:@ fallback")
	}
	if !strings.Contains(err.Error(), "telegram username target is not sendable") {
		t.Fatalf("Send() error mismatch: got %q", err.Error())
	}
	if calls != 0 {
		t.Fatalf("send calls mismatch: got %d want 0", calls)
	}
}

type mockDataPusher struct {
	mu      sync.Mutex
	result  maep.DataPushResult
	err     error
	calls   int
	peerID  string
	req     maep.DataPushRequest
	addrs   []string
	notify  bool
	context context.Context
}

func (m *mockDataPusher) PushData(ctx context.Context, peerID string, addresses []string, req maep.DataPushRequest, notification bool) (maep.DataPushResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls++
	m.peerID = peerID
	m.req = req
	m.addrs = append([]string(nil), addresses...)
	m.notify = notification
	m.context = ctx
	return m.result, m.err
}

func newRoutingSenderForBusTest(t *testing.T, sendText telegrambus.SendTextFunc, pusher maepbus.DataPusher) *RoutingSender {
	t.Helper()

	if sendText == nil {
		t.Fatalf("sendText is required")
	}
	if pusher == nil {
		t.Fatalf("pusher is required")
	}

	logger := slog.New(slog.NewTextHandler(io.Discard, &slog.HandlerOptions{Level: slog.LevelDebug}))
	bus, err := busruntime.NewInproc(busruntime.InprocOptions{
		MaxInFlight: 8,
		Logger:      logger,
	})
	if err != nil {
		t.Fatalf("NewInproc() error = %v", err)
	}

	telegramDelivery, err := telegrambus.NewDeliveryAdapter(telegrambus.DeliveryAdapterOptions{
		SendText: sendText,
	})
	if err != nil {
		t.Fatalf("NewDeliveryAdapter(telegram) error = %v", err)
	}
	maepDelivery, err := maepbus.NewDeliveryAdapter(maepbus.DeliveryAdapterOptions{
		Node: pusher,
	})
	if err != nil {
		t.Fatalf("NewDeliveryAdapter(maep) error = %v", err)
	}

	sender := &RoutingSender{
		bus:                  bus,
		telegramDelivery:     telegramDelivery,
		maepDelivery:         maepDelivery,
		allowHumanSend:       true,
		allowHumanPublicSend: true,
		pending:              make(map[string]chan deliveryResult),
	}

	busHandler := func(deliverCtx context.Context, msg busruntime.BusMessage) error {
		if msg.Direction != busruntime.DirectionOutbound {
			deliverErr := fmt.Errorf("unsupported direction: %s", msg.Direction)
			if err := sender.completePending(msg.ID, deliveryResult{err: deliverErr}); err != nil {
				return err
			}
			return deliverErr
		}
		var (
			accepted   bool
			deduped    bool
			deliverErr error
		)
		switch msg.Channel {
		case busruntime.ChannelTelegram:
			accepted, deduped, deliverErr = sender.telegramDelivery.Deliver(deliverCtx, msg)
		case busruntime.ChannelMAEP:
			accepted, deduped, deliverErr = sender.maepDelivery.Deliver(deliverCtx, msg)
		default:
			deliverErr = fmt.Errorf("unsupported outbound channel: %s", msg.Channel)
		}
		if err := sender.completePending(msg.ID, deliveryResult{
			accepted: accepted,
			deduped:  deduped,
			err:      deliverErr,
		}); err != nil {
			return err
		}
		return deliverErr
	}
	for _, topic := range busruntime.AllTopics() {
		if err := sender.bus.Subscribe(topic, busHandler); err != nil {
			t.Fatalf("Subscribe(%s) error = %v", topic, err)
		}
	}

	t.Cleanup(func() {
		_ = sender.Close()
	})
	return sender
}

func testEnvelopePayload(t *testing.T, text string) (string, string) {
	t.Helper()

	sessionID, err := uuid.NewV7()
	if err != nil {
		t.Fatalf("uuid.NewV7() error = %v", err)
	}
	payloadRaw, err := json.Marshal(map[string]any{
		"text":       text,
		"session_id": sessionID.String(),
	})
	if err != nil {
		t.Fatalf("json.Marshal() error = %v", err)
	}
	return "application/json", base64.RawURLEncoding.EncodeToString(payloadRaw)
}
