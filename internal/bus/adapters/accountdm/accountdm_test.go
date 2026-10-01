package accountdm

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
)

func TestInboundRoundTripDedupeAndContacts(t *testing.T) {
	ctx := context.Background()
	store := contacts.NewFileStore(t.TempDir())
	if err := store.Ensure(ctx); err != nil {
		t.Fatal(err)
	}
	bus, err := busruntime.NewInproc(busruntime.InprocOptions{MaxInFlight: 4, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	defer bus.Close()
	received := make(chan busruntime.BusMessage, 2)
	_ = bus.Subscribe(busruntime.TopicChatMessage, func(_ context.Context, msg busruntime.BusMessage) error {
		received <- msg
		return nil
	})
	adapter, err := NewInboundAdapter(InboundAdapterOptions{Channel: busruntime.ChannelWhatsApp, Bus: bus, Store: store})
	if err != nil {
		t.Fatal(err)
	}
	in := InboundMessage{AccountID: "123", PeerID: "509", MessageID: "wamid.A", SentAt: time.Unix(1790000000, 0), DisplayName: "Alex", Text: "hi", ReplyToMessageID: "wamid.Z"}
	if ok, err := adapter.HandleInboundMessage(ctx, in); !ok || err != nil {
		t.Fatalf("HandleInboundMessage = %v, %v", ok, err)
	}
	msg := <-received
	if msg.ConversationKey != "whatsapp:123:509" || msg.Extensions.PlatformMessageID != "123:wamid.A" {
		t.Fatalf("message = %+v", msg)
	}
	back, err := InboundMessageFromBusMessage(msg)
	if err != nil || back.PeerID != "509" || back.AccountID != "123" || back.MessageID != "wamid.A" || back.Text != "hi" || back.ReplyToMessageID != "wamid.Z" || back.DisplayName != "Alex" {
		t.Fatalf("round trip = %+v, %v", back, err)
	}
	if ok, err := adapter.HandleInboundMessage(ctx, in); ok || err != nil {
		t.Fatalf("a replayed message was accepted: %v, %v", ok, err)
	}

	service := contacts.NewService(store)
	if err := service.ObserveInboundBusMessage(ctx, msg, time.Now()); err != nil {
		t.Fatal(err)
	}
	contact, found, err := store.GetContact(ctx, "whatsapp_user:509")
	if err != nil || !found || contact.WhatsAppUserID != "509" || contact.Channel != contacts.ChannelWhatsApp || contact.ContactNickname != "Alex" {
		t.Fatalf("contact = %+v found=%v err=%v", contact, found, err)
	}
}

func TestDeliveryParsesTheConversation(t *testing.T) {
	var got []string
	adapter, err := NewDeliveryAdapter(busruntime.ChannelWeChat, func(_ context.Context, account, peer, text, replyTo string) error {
		got = []string{account, peer, text, replyTo}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	msg, err := NewOutbound(busruntime.ChannelWeChat, "bot@im.bot", "o9x@im.wechat", "the answer", "", "corr")
	if err != nil {
		t.Fatal(err)
	}
	if err := adapter.Deliver(context.Background(), msg); err != nil {
		t.Fatal(err)
	}
	if got[0] != "bot@im.bot" || got[1] != "o9x@im.wechat" || got[2] != "the answer" {
		t.Fatalf("delivered = %v", got)
	}
}
