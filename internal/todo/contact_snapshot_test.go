package todo

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
)

func TestLoadContactSnapshot(t *testing.T) {
	contactsDir := t.TempDir()
	svc := contacts.NewService(contacts.NewFileStore(contactsDir))
	now := time.Date(2026, 2, 9, 12, 0, 0, 0, time.UTC)

	_, err := svc.UpsertContact(context.Background(), contacts.Contact{
		ContactID:       "tg:@john",
		ContactNickname: "John",
		Kind:            contacts.KindHuman,
		Status:          contacts.StatusActive,
		SubjectID:       "tg:@john",
		ChannelEndpoints: []contacts.ChannelEndpoint{
			{Channel: contacts.ChannelTelegram, ChatID: 1001, Address: "@john"},
		},
	}, now)
	if err != nil {
		t.Fatalf("UpsertContact(john) error = %v", err)
	}

	_, err = svc.UpsertContact(context.Background(), contacts.Contact{
		ContactID:       "maep:alice",
		ContactNickname: "Alice",
		Kind:            contacts.KindAgent,
		Status:          contacts.StatusActive,
		PeerID:          "12D3KooWAlicePeer",
	}, now)
	if err != nil {
		t.Fatalf("UpsertContact(alice) error = %v", err)
	}

	snap, err := LoadContactSnapshot(context.Background(), contactsDir)
	if err != nil {
		t.Fatalf("LoadContactSnapshot() error = %v", err)
	}
	if len(snap.Contacts) != 2 {
		t.Fatalf("contacts count mismatch: got %d want 2", len(snap.Contacts))
	}
	for _, id := range []string{"tg:id:1001", "maep:12D3KooWAlicePeer"} {
		if !snap.HasReachableID(id) {
			t.Fatalf("expected reachable id %q", id)
		}
	}
}

func TestValidateReachableReferences(t *testing.T) {
	snap := ContactSnapshot{
		ReachableIDs: []string{"maep:12D3KooWJohn", "tg:id:1001"},
	}

	if err := ValidateReachableReferences("提醒 John (tg:id:1001) 明天确认", snap); err != nil {
		t.Fatalf("ValidateReachableReferences(snapshot tg id) error = %v", err)
	}
	if err := ValidateReachableReferences("提醒 John (maep:12D3KooWJohn) 明天确认", snap); err != nil {
		t.Fatalf("ValidateReachableReferences(snapshot id) error = %v", err)
	}
	err := ValidateReachableReferences("提醒 John (maep:unknown) 明天确认", snap)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "not reachable") {
		t.Fatalf("expected not reachable error, got %v", err)
	}
}
