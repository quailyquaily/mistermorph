package telegramcmd

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
)

func TestObserveTelegramContact_UpsertByUsername(t *testing.T) {
	ctx := context.Background()
	svc := contacts.NewService(contacts.NewFileStore(filepath.Join(t.TempDir(), "contacts")))
	now := time.Date(2026, 2, 7, 15, 0, 0, 0, time.UTC)

	if err := observeTelegramContact(ctx, svc, 90001, "private", 1001, "alice", "Alice", "", "Alice L", now); err != nil {
		t.Fatalf("observeTelegramContact() error = %v", err)
	}

	item, ok, err := svc.GetContact(ctx, "tg:@alice")
	if err != nil {
		t.Fatalf("GetContact() error = %v", err)
	}
	if !ok {
		t.Fatalf("GetContact expected ok=true")
	}
	if item.Kind != contacts.KindHuman {
		t.Fatalf("kind mismatch: got %s want %s", item.Kind, contacts.KindHuman)
	}
	if item.Channel != contacts.ChannelTelegram {
		t.Fatalf("channel mismatch: got %s want %s", item.Channel, contacts.ChannelTelegram)
	}
	if item.TGUsername != "alice" {
		t.Fatalf("tg_username mismatch: got %s", item.TGUsername)
	}
	if item.PrivateChatID != 90001 {
		t.Fatalf("private_chat_id mismatch: got %d", item.PrivateChatID)
	}
	if item.ContactNickname != "Alice L" {
		t.Fatalf("contact_nickname mismatch: got %q", item.ContactNickname)
	}
	if item.LastInteractionAt == nil {
		t.Fatalf("last_interaction_at expected non-nil")
	}
}

func TestObserveTelegramContact_FallbackToUserID(t *testing.T) {
	ctx := context.Background()
	svc := contacts.NewService(contacts.NewFileStore(filepath.Join(t.TempDir(), "contacts")))
	now := time.Date(2026, 2, 7, 15, 30, 0, 0, time.UTC)

	if err := observeTelegramContact(ctx, svc, -100778899, "group", 2002, "", "Bob", "", "", now); err != nil {
		t.Fatalf("observeTelegramContact() error = %v", err)
	}

	item, ok, err := svc.GetContact(ctx, "tg:2002")
	if err != nil {
		t.Fatalf("GetContact() error = %v", err)
	}
	if !ok {
		t.Fatalf("GetContact expected ok=true")
	}
	if item.ContactNickname != "Bob" {
		t.Fatalf("contact_nickname mismatch: got %q", item.ContactNickname)
	}
	if len(item.GroupChatIDs) != 1 || item.GroupChatIDs[0] != -100778899 {
		t.Fatalf("group_chat_ids mismatch: got=%v", item.GroupChatIDs)
	}
}
