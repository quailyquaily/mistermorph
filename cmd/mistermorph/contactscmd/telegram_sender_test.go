package contactscmd

import (
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/contactsruntime"
)

func TestResolveTelegramTargetByDecisionChatID(t *testing.T) {
	contact := contacts.Contact{
		ContactID:     "tg:1001",
		Kind:          contacts.KindHuman,
		Channel:       contacts.ChannelTelegram,
		PrivateChatID: 1001,
		GroupChatIDs:  []int64{-1002233},
	}
	target, chatType, err := contactsruntime.ResolveTelegramTarget(contact, contacts.ShareDecision{SourceChatID: -1002233})
	if err != nil {
		t.Fatalf("resolveTelegramTarget() error = %v", err)
	}
	got, ok := target.(int64)
	if !ok || got != -1002233 {
		t.Fatalf("target mismatch: got=%T %v", target, target)
	}
	if chatType != "supergroup" {
		t.Fatalf("chat type mismatch: got %q want %q", chatType, "supergroup")
	}
}

func TestResolveTelegramTargetByDecisionChatType(t *testing.T) {
	contact := contacts.Contact{
		ContactID:     "tg:1001",
		Kind:          contacts.KindHuman,
		Channel:       contacts.ChannelTelegram,
		PrivateChatID: 1001,
		GroupChatIDs:  []int64{-1008899},
	}
	target, chatType, err := contactsruntime.ResolveTelegramTarget(contact, contacts.ShareDecision{SourceChatType: "group"})
	if err != nil {
		t.Fatalf("resolveTelegramTarget() error = %v", err)
	}
	got, ok := target.(int64)
	if !ok || got != -1008899 {
		t.Fatalf("target mismatch: got=%T %v", target, target)
	}
	if chatType != "supergroup" {
		t.Fatalf("chat type mismatch: got %q want %q", chatType, "supergroup")
	}
}

func TestResolveTelegramTargetFallsBackToPrivate(t *testing.T) {
	contact := contacts.Contact{
		ContactID:     "tg:1001",
		Kind:          contacts.KindHuman,
		Channel:       contacts.ChannelTelegram,
		PrivateChatID: 1001,
		GroupChatIDs:  []int64{-100111},
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
		Channel:   contacts.ChannelTelegram,
	}
	target, chatType, err := contactsruntime.ResolveTelegramTarget(contact, contacts.ShareDecision{})
	if err == nil {
		t.Fatalf("resolveTelegramTarget() expected error for tg:@ fallback")
	}
	if !strings.Contains(err.Error(), "telegram username target is not sendable") {
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
	contact := contacts.Contact{
		ContactID:     "tg:1001",
		Kind:          contacts.KindHuman,
		Channel:       contacts.ChannelTelegram,
		PrivateChatID: 1001,
		GroupChatIDs:  []int64{-100789},
	}
	if !contactsruntime.IsPublicTelegramTarget(contact, contacts.ShareDecision{SourceChatID: -100789}, int64(-100789), "supergroup") {
		t.Fatalf("expected public target for group chat")
	}
	if contactsruntime.IsPublicTelegramTarget(contact, contacts.ShareDecision{}, int64(1001), "private") {
		t.Fatalf("did not expect public target for private chat")
	}
}
