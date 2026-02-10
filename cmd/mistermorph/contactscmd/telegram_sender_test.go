package contactscmd

import (
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/contactsruntime"
)

func TestResolveTelegramTargetByDecisionChatID(t *testing.T) {
	now := time.Date(2026, 2, 7, 18, 0, 0, 0, time.UTC)
	contact := contacts.Contact{
		ContactID: "tg:1001",
		Kind:      contacts.KindHuman,
		ChannelEndpoints: []contacts.ChannelEndpoint{
			{Channel: contacts.ChannelTelegram, Address: "1001", ChatID: 1001, ChatType: "private", LastSeenAt: &now},
			{Channel: contacts.ChannelTelegram, Address: "-1002233", ChatID: -1002233, ChatType: "group", LastSeenAt: &now},
		},
	}
	target, chatType, err := contactsruntime.ResolveTelegramTarget(contact, contacts.ShareDecision{SourceChatID: -1002233})
	if err != nil {
		t.Fatalf("resolveTelegramTarget() error = %v", err)
	}
	got, ok := target.(int64)
	if !ok || got != -1002233 {
		t.Fatalf("target mismatch: got=%T %v", target, target)
	}
	if chatType != "group" {
		t.Fatalf("chat type mismatch: got %q want %q", chatType, "group")
	}
}

func TestResolveTelegramTargetByDecisionChatType(t *testing.T) {
	now := time.Date(2026, 2, 7, 18, 30, 0, 0, time.UTC)
	contact := contacts.Contact{
		ContactID: "tg:1001",
		Kind:      contacts.KindHuman,
		ChannelEndpoints: []contacts.ChannelEndpoint{
			{Channel: contacts.ChannelTelegram, Address: "1001", ChatID: 1001, ChatType: "private", LastSeenAt: &now},
			{Channel: contacts.ChannelTelegram, Address: "-1008899", ChatID: -1008899, ChatType: "group", LastSeenAt: &now},
		},
	}
	target, chatType, err := contactsruntime.ResolveTelegramTarget(contact, contacts.ShareDecision{SourceChatType: "group"})
	if err != nil {
		t.Fatalf("resolveTelegramTarget() error = %v", err)
	}
	got, ok := target.(int64)
	if !ok || got != -1008899 {
		t.Fatalf("target mismatch: got=%T %v", target, target)
	}
	if chatType != "group" {
		t.Fatalf("chat type mismatch: got %q want %q", chatType, "group")
	}
}

func TestResolveTelegramTargetFallsBackToPrivate(t *testing.T) {
	now := time.Date(2026, 2, 7, 19, 0, 0, 0, time.UTC)
	contact := contacts.Contact{
		ContactID: "tg:1001",
		Kind:      contacts.KindHuman,
		ChannelEndpoints: []contacts.ChannelEndpoint{
			{Channel: contacts.ChannelTelegram, Address: "-100111", ChatID: -100111, ChatType: "group", LastSeenAt: &now},
			{Channel: contacts.ChannelTelegram, Address: "1001", ChatID: 1001, ChatType: "private", LastSeenAt: &now},
		},
	}
	target, chatType, err := contactsruntime.ResolveTelegramTarget(contact, contacts.ShareDecision{})
	if err != nil {
		t.Fatalf("resolveTelegramTarget() error = %v", err)
	}
	got, ok := target.(int64)
	if !ok || got != 1001 {
		t.Fatalf("target mismatch: got=%T %v", target, target)
	}
	if chatType != "private" {
		t.Fatalf("chat type mismatch: got %q want %q", chatType, "private")
	}
}

func TestResolveTelegramTargetLegacyUsernameUnsupported(t *testing.T) {
	contact := contacts.Contact{
		ContactID: "tg:@alice",
		Kind:      contacts.KindHuman,
	}
	target, chatType, err := contactsruntime.ResolveTelegramTarget(contact, contacts.ShareDecision{})
	if err == nil {
		t.Fatalf("resolveTelegramTarget() expected error for tg:@ fallback")
	}
	if !strings.Contains(err.Error(), "telegram target not found in subject_id/contact_id") {
		t.Fatalf("resolveTelegramTarget() error mismatch: got %q", err.Error())
	}
	if target != nil {
		t.Fatalf("target mismatch: got=%T %v want nil", target, target)
	}
	if chatType != "" {
		t.Fatalf("chatType mismatch: got %q want empty", chatType)
	}
}

func TestIsPublicTelegramTarget(t *testing.T) {
	now := time.Date(2026, 2, 7, 19, 30, 0, 0, time.UTC)
	contact := contacts.Contact{
		ContactID: "tg:1001",
		Kind:      contacts.KindHuman,
		ChannelEndpoints: []contacts.ChannelEndpoint{
			{Channel: contacts.ChannelTelegram, Address: "1001", ChatID: 1001, ChatType: "private", LastSeenAt: &now},
			{Channel: contacts.ChannelTelegram, Address: "-100789", ChatID: -100789, ChatType: "group", LastSeenAt: &now},
		},
	}
	if !contactsruntime.IsPublicTelegramTarget(contact, contacts.ShareDecision{SourceChatID: -100789}, int64(-100789), "group") {
		t.Fatalf("expected public target for group chat")
	}
	if contactsruntime.IsPublicTelegramTarget(contact, contacts.ShareDecision{}, int64(1001), "private") {
		t.Fatalf("did not expect public target for private chat")
	}
}
