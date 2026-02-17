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
	slackbus "github.com/quailyquaily/mistermorph/internal/bus/adapters/slack"
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
	sendText := func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
		mu.Lock()
		defer mu.Unlock()
		gotTarget = target
		gotText = text
		return nil
	}

	sender := newRoutingSenderForBusTest(t, sendText, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello telegram")
	accepted, deduped, err := sender.Send(ctx, contacts.Contact{
		ContactID:       "tg:12345",
		Kind:            contacts.KindHuman,
		Channel:         contacts.ChannelTelegram,
		TGPrivateChatID: 12345,
	}, contacts.ShareDecision{
		ContactID:      "tg:12345",
		ItemID:         "cand_1",
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

func TestRoutingSenderSendTelegramViaBus_ChatIDHintMatchGroup(t *testing.T) {
	ctx := context.Background()

	var (
		mu        sync.Mutex
		gotTarget any
	)
	sendText := func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
		mu.Lock()
		defer mu.Unlock()
		gotTarget = target
		return nil
	}

	sender := newRoutingSenderForBusTest(t, sendText, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello telegram")
	_, _, err := sender.Send(ctx, contacts.Contact{
		ContactID:       "tg:@alice",
		Kind:            contacts.KindHuman,
		Channel:         contacts.ChannelTelegram,
		TGPrivateChatID: 12345,
		TGGroupChatIDs:  []int64{-1007788},
	}, contacts.ShareDecision{
		ContactID:      "tg:@alice",
		ChatID:         "tg:-1007788",
		ItemID:         "cand_hint_group",
		ContentType:    contentType,
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "manual:tg:hint-group",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotTarget != int64(-1007788) {
		t.Fatalf("target mismatch: got %#v want %d", gotTarget, int64(-1007788))
	}
}

func TestRoutingSenderSendTelegramViaBus_ChatIDHintFallsBackToPrivate(t *testing.T) {
	ctx := context.Background()

	var (
		mu        sync.Mutex
		gotTarget any
	)
	sendText := func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
		mu.Lock()
		defer mu.Unlock()
		gotTarget = target
		return nil
	}

	sender := newRoutingSenderForBusTest(t, sendText, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello telegram")
	_, _, err := sender.Send(ctx, contacts.Contact{
		ContactID:       "tg:@alice",
		Kind:            contacts.KindHuman,
		Channel:         contacts.ChannelTelegram,
		TGPrivateChatID: 12345,
		TGGroupChatIDs:  []int64{-1007788},
	}, contacts.ShareDecision{
		ContactID:      "tg:@alice",
		ChatID:         "tg:-1009999",
		ItemID:         "cand_hint_private",
		ContentType:    contentType,
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "manual:tg:hint-private",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if gotTarget != int64(12345) {
		t.Fatalf("target mismatch: got %#v want %d", gotTarget, int64(12345))
	}
}

func TestRoutingSenderSendTelegramViaBus_ChatIDHintNoPrivateFallback(t *testing.T) {
	ctx := context.Background()

	calls := 0
	sendText := func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
		calls++
		return nil
	}

	sender := newRoutingSenderForBusTest(t, sendText, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello telegram")
	_, _, err := sender.Send(ctx, contacts.Contact{
		ContactID:      "tg:@alice",
		Kind:           contacts.KindHuman,
		Channel:        contacts.ChannelTelegram,
		TGGroupChatIDs: []int64{-1007788},
	}, contacts.ShareDecision{
		ContactID:      "tg:@alice",
		ChatID:         "tg:-1009999",
		ItemID:         "cand_hint_error",
		ContentType:    contentType,
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "manual:tg:hint-error",
	})
	if err == nil {
		t.Fatalf("Send() expected error when chat_id hint misses and no private fallback")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "no tg_private_chat_id fallback") {
		t.Fatalf("Send() error mismatch: got %q", err.Error())
	}
	if calls != 0 {
		t.Fatalf("send calls mismatch: got %d want 0", calls)
	}
}

func TestRoutingSenderSendSlackViaBus_WithDMTarget(t *testing.T) {
	ctx := context.Background()

	var (
		mu     sync.Mutex
		got    slackbus.DeliveryTarget
		gotRaw any
		gotTxt string
	)
	sendSlack := func(ctx context.Context, target any, text string, opts slackbus.SendTextOptions) error {
		mu.Lock()
		defer mu.Unlock()
		gotRaw = target
		gotTxt = text
		deliveryTarget, ok := target.(slackbus.DeliveryTarget)
		if !ok {
			return fmt.Errorf("target type mismatch: %T", target)
		}
		got = deliveryTarget
		return nil
	}
	sendTelegram := func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
		return fmt.Errorf("unexpected telegram send: target=%v text=%q", target, text)
	}

	sender := newRoutingSenderForBusTest(t, sendTelegram, &mockDataPusher{}, sendSlack)
	contentType, payloadBase64 := testEnvelopePayload(t, "hello slack")
	accepted, deduped, err := sender.Send(ctx, contacts.Contact{
		ContactID:        "slack:T111:U222",
		Kind:             contacts.KindHuman,
		Channel:          contacts.ChannelSlack,
		SlackTeamID:      "T111",
		SlackUserID:      "U222",
		SlackDMChannelID: "D333",
	}, contacts.ShareDecision{
		ContactID:      "slack:T111:U222",
		ItemID:         "cand_slack_1",
		ContentType:    contentType,
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "manual:slack:1",
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
	if gotRaw == nil {
		t.Fatalf("expected slack send target")
	}
	if got.TeamID != "T111" || got.ChannelID != "D333" {
		t.Fatalf("slack target mismatch: got=%+v want team=T111 channel=D333", got)
	}
	if gotTxt != "hello slack" {
		t.Fatalf("text mismatch: got %q want %q", gotTxt, "hello slack")
	}
}

func TestRoutingSenderSendSlackViaBus_WithChatIDHint(t *testing.T) {
	ctx := context.Background()

	var (
		mu  sync.Mutex
		got slackbus.DeliveryTarget
	)
	sendSlack := func(ctx context.Context, target any, text string, opts slackbus.SendTextOptions) error {
		mu.Lock()
		defer mu.Unlock()
		deliveryTarget, ok := target.(slackbus.DeliveryTarget)
		if !ok {
			return fmt.Errorf("target type mismatch: %T", target)
		}
		got = deliveryTarget
		return nil
	}

	sender := newRoutingSenderForBusTest(
		t,
		func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
			return fmt.Errorf("unexpected telegram send: target=%v text=%q", target, text)
		},
		&mockDataPusher{},
		sendSlack,
	)
	contentType, payloadBase64 := testEnvelopePayload(t, "hello slack by hint")
	_, _, err := sender.Send(ctx, contacts.Contact{
		ContactID: "contact:any",
		Kind:      contacts.KindHuman,
		Channel:   contacts.ChannelTelegram,
	}, contacts.ShareDecision{
		ContactID:      "contact:any",
		ChatID:         "slack:T999:C888",
		ItemID:         "cand_slack_2",
		ContentType:    contentType,
		PayloadBase64:  payloadBase64,
		IdempotencyKey: "manual:slack:2",
	})
	if err != nil {
		t.Fatalf("Send() error = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if got.TeamID != "T999" || got.ChannelID != "C888" {
		t.Fatalf("slack target mismatch: got=%+v want team=T999 channel=C888", got)
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
	sendText := func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
		return fmt.Errorf("unexpected telegram send: target=%v text=%q", target, text)
	}
	sender := newRoutingSenderForBusTest(t, sendText, pusher)

	contentType, payloadBase64 := testEnvelopePayload(t, "hello maep")
	accepted, deduped, err := sender.Send(ctx, contacts.Contact{
		ContactID:  "maep:12D3KooWTestPeer",
		Kind:       contacts.KindAgent,
		Channel:    contacts.ChannelMAEP,
		MAEPNodeID: "maep:12D3KooWTestPeer",
	}, contacts.ShareDecision{
		ContactID:      "maep:12D3KooWTestPeer",
		ItemID:         "cand_2",
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
	if pusher.req.Topic != contacts.ShareTopic {
		t.Fatalf("topic mismatch: got %q want %q", pusher.req.Topic, contacts.ShareTopic)
	}
	if pusher.req.IdempotencyKey != "manual:maep:1" {
		t.Fatalf("idempotency_key mismatch: got %q want %q", pusher.req.IdempotencyKey, "manual:maep:1")
	}
}

func TestRoutingSenderSendFailsWithoutIdempotencyKey(t *testing.T) {
	ctx := context.Background()

	sender := newRoutingSenderForBusTest(t, func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
		return nil
	}, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello")
	_, _, err := sender.Send(ctx, contacts.Contact{
		ContactID:       "tg:12345",
		Kind:            contacts.KindHuman,
		Channel:         contacts.ChannelTelegram,
		TGPrivateChatID: 12345,
	}, contacts.ShareDecision{
		ContactID:     "tg:12345",
		ItemID:        "cand_3",
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
	sender := newRoutingSenderForBusTest(t, func(ctx context.Context, target any, text string, opts telegrambus.SendTextOptions) error {
		calls++
		return nil
	}, &mockDataPusher{})
	contentType, payloadBase64 := testEnvelopePayload(t, "hello")
	_, _, err := sender.Send(ctx, contacts.Contact{
		ContactID:  "tg:@alice",
		Kind:       contacts.KindHuman,
		Channel:    contacts.ChannelTelegram,
		TGUsername: "alice",
	}, contacts.ShareDecision{
		ContactID:      "tg:@alice",
		ItemID:         "cand_4",
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

func newRoutingSenderForBusTest(t *testing.T, sendText telegrambus.SendTextFunc, pusher maepbus.DataPusher, slackSendText ...slackbus.SendTextFunc) *RoutingSender {
	t.Helper()

	if sendText == nil {
		t.Fatalf("sendText is required")
	}
	if pusher == nil {
		t.Fatalf("pusher is required")
	}
	sendSlack := func(ctx context.Context, target any, text string, opts slackbus.SendTextOptions) error {
		return fmt.Errorf("unexpected slack send: target=%v text=%q", target, text)
	}
	if len(slackSendText) > 0 && slackSendText[0] != nil {
		sendSlack = slackSendText[0]
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
	slackDelivery, err := slackbus.NewDeliveryAdapter(slackbus.DeliveryAdapterOptions{
		SendText: sendSlack,
	})
	if err != nil {
		t.Fatalf("NewDeliveryAdapter(slack) error = %v", err)
	}

	sender := &RoutingSender{
		bus:              bus,
		telegramDelivery: telegramDelivery,
		slackDelivery:    slackDelivery,
		maepDelivery:     maepDelivery,
		pending:          make(map[string]chan deliveryResult),
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
		case busruntime.ChannelSlack:
			accepted, deduped, deliverErr = sender.slackDelivery.Deliver(deliverCtx, msg)
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
