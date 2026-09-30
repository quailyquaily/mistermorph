package discord

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
)

func newTestBus(t *testing.T) *busruntime.Inproc {
	t.Helper()
	bus, err := busruntime.NewInproc(busruntime.InprocOptions{MaxInFlight: 4, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = bus.Close() })
	return bus
}

func TestInboundAdapterPublishesAndDedupesDiscordMessages(t *testing.T) {
	ctx := context.Background()
	store := contacts.NewFileStore(t.TempDir())
	if err := store.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	bus := newTestBus(t)
	received := make(chan busruntime.BusMessage, 2)
	if err := bus.Subscribe(busruntime.TopicChatMessage, func(_ context.Context, msg busruntime.BusMessage) error {
		received <- msg
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	adapter, err := NewInboundAdapter(InboundAdapterOptions{Bus: bus, Store: store})
	if err != nil {
		t.Fatal(err)
	}
	sentAt := time.Date(2026, 9, 30, 10, 0, 0, 0, time.UTC)
	in := InboundMessage{
		ChannelID: "200", GuildID: "100", MessageID: "300", SentAt: sentAt, ChatType: "group",
		UserID: "400", Username: "ann", DisplayName: "Ann", Text: "hello", ReplyToMessageID: "299",
		MentionUserIDs: []string{"42", "42"},
		ImageAttachments: []busruntime.ImageAttachment{{
			Path: "/tmp/discord-photo.png", SourceMessageID: "300", SourceAttachmentID: "500", MIMEType: "image/png",
		}},
	}
	accepted, err := adapter.HandleInboundMessage(ctx, in)
	if err != nil || !accepted {
		t.Fatalf("HandleInboundMessage() = %v, %v", accepted, err)
	}
	var msg busruntime.BusMessage
	select {
	case msg = <-received:
	case <-time.After(time.Second):
		t.Fatal("message not published")
	}
	if msg.Channel != busruntime.ChannelDiscord || msg.ConversationKey != "discord:200" || msg.Extensions.PlatformMessageID != "200:300" || msg.Extensions.GuildID != "100" {
		t.Fatalf("message = %#v", msg)
	}
	back, err := InboundMessageFromBusMessage(msg)
	if err != nil {
		t.Fatal(err)
	}
	if back.ChannelID != "200" || back.GuildID != "100" || back.MessageID != "300" || back.UserID != "400" || back.Text != "hello" ||
		back.ReplyToMessageID != "299" || len(back.MentionUserIDs) != 1 || back.ChatType != ChatTypeGroup || len(back.ImageAttachments) != 1 || !back.SentAt.Equal(sentAt) {
		t.Fatalf("round trip = %#v", back)
	}
	// A Gateway resume replays the same message: it must not be published again.
	accepted, err = adapter.HandleInboundMessage(ctx, in)
	if err != nil || accepted {
		t.Fatalf("replayed message accepted=%v err=%v", accepted, err)
	}
	select {
	case again := <-received:
		t.Fatalf("replayed message published: %#v", again)
	case <-time.After(50 * time.Millisecond):
	}
}

func TestInboundAdapterRejectsInvalidMessages(t *testing.T) {
	ctx := context.Background()
	store := contacts.NewFileStore(t.TempDir())
	if err := store.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	adapter, err := NewInboundAdapter(InboundAdapterOptions{Bus: newTestBus(t), Store: store})
	if err != nil {
		t.Fatal(err)
	}
	valid := InboundMessage{ChannelID: "1", MessageID: "2", UserID: "3", ChatType: "private", Text: "hi"}
	for name, mutate := range map[string]func(*InboundMessage){
		"bad channel": func(m *InboundMessage) { m.ChannelID = "abc" },
		"bad user":    func(m *InboundMessage) { m.UserID = "" },
		"bad type":    func(m *InboundMessage) { m.ChatType = "dm" },
		"no text":     func(m *InboundMessage) { m.Text = " " },
		"bad reply":   func(m *InboundMessage) { m.ReplyToMessageID = "x" },
	} {
		t.Run(name, func(t *testing.T) {
			msg := valid
			mutate(&msg)
			if _, err := adapter.HandleInboundMessage(ctx, msg); err == nil {
				t.Fatal("invalid message accepted")
			}
		})
	}
}

func TestDeliveryAdapterSendsToTheChannel(t *testing.T) {
	var gotChannel, gotText string
	var gotOpts SendTextOptions
	adapter, err := NewDeliveryAdapter(DeliveryAdapterOptions{SendText: func(_ context.Context, channelID, text string, opts SendTextOptions) error {
		gotChannel, gotText, gotOpts = channelID, text, opts
		return nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := busruntime.EncodeMessageEnvelope(busruntime.TopicChatMessage, busruntime.MessageEnvelope{
		MessageID: "m1", Text: "the answer", SentAt: time.Now().UTC().Format(time.RFC3339), SessionID: "0190e0c0-0000-7000-8000-000000000000",
	})
	if err != nil {
		t.Fatal(err)
	}
	sent, _, err := adapter.Deliver(context.Background(), busruntime.BusMessage{
		ID: "bus_1", Direction: busruntime.DirectionOutbound, Channel: busruntime.ChannelDiscord, Topic: busruntime.TopicChatMessage,
		ConversationKey: "discord:200", CorrelationID: "discord:message:t1", PayloadBase64: payload,
		Extensions: busruntime.MessageExtensions{ReplyTo: "300"},
	})
	if err != nil || !sent || gotChannel != "200" || gotText != "the answer" || gotOpts.ReplyToMessageID != "300" || gotOpts.CorrelationID != "discord:message:t1" {
		t.Fatalf("Deliver = %v, %v; channel=%q text=%q opts=%+v", sent, err, gotChannel, gotText, gotOpts)
	}
}
