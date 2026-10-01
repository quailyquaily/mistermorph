package contactsruntime

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/livesend"
)

type liveRecorder struct{ sent []string }

func (l *liveRecorder) SendText(_ context.Context, peerID, text string) error {
	l.sent = append(l.sent, peerID+"|"+text)
	return nil
}

func (l *liveRecorder) NotifyTargets() []string { return nil }

func TestSendToWeChatGoesThroughTheRunningRuntime(t *testing.T) {
	sender, err := NewRoutingSender(context.Background(), SenderOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	envelope, _ := json.Marshal(map[string]any{"message_id": "m1", "text": "the report is ready", "sent_at": "2026-10-01T10:00:00Z", "session_id": uuid.Must(uuid.NewV7()).String()})
	contact := contacts.Contact{ContactID: "wechat_user:o9u@im.wechat", Channel: contacts.ChannelWeChat, WeChatUserID: "o9u@im.wechat"}
	decision := contacts.ShareDecision{ContactID: contact.ContactID, ContentType: "application/json", PayloadBase64: base64.RawURLEncoding.EncodeToString(envelope), IdempotencyKey: "manual:wechat:1"}
	if _, _, err := sender.Send(context.Background(), contact, decision); !errors.Is(err, livesend.ErrNotRunning) {
		t.Fatalf("Send with no WeChat runtime = %v", err)
	}
	live := &liveRecorder{}
	defer livesend.Register("wechat", live)()
	accepted, _, err := sender.Send(context.Background(), contact, decision)
	if err != nil || !accepted || len(live.sent) != 1 || live.sent[0] != "o9u@im.wechat|the report is ready" {
		t.Fatalf("Send() = %v, %v; sent %q", accepted, err, live.sent)
	}
	decision.ChatID = "wechat:someone-else@im.wechat"
	if _, _, err := sender.Send(context.Background(), contact, decision); err == nil {
		t.Fatal("sent to a chat_id that is not the contact's")
	}
}
