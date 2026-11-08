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
	svc := contacts.NewService(contacts.NewStore(contactsDir))
	now := time.Date(2026, 2, 9, 12, 0, 0, 0, time.UTC)

	_, err := svc.UpsertContact(context.Background(), contacts.Contact{
		ContactID:       "tg:@john",
		ContactNickname: "John",
		Kind:            contacts.KindHuman,
		Channel:         contacts.ChannelTelegram,
		TGUsername:      "john",
		TGPrivateChatID: 1001,
	}, now)
	if err != nil {
		t.Fatalf("UpsertContact(john) error = %v", err)
	}

	_, err = svc.UpsertContact(context.Background(), contacts.Contact{
		ContactID:        "slack:T001:D002",
		ContactNickname:  "Alice",
		Kind:             contacts.KindHuman,
		Channel:          contacts.ChannelSlack,
		SlackTeamID:      "T001",
		SlackDMChannelID: "D002",
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
	foundJohn := false
	for _, item := range snap.Contacts {
		if strings.EqualFold(item.Name, "John") {
			foundJohn = true
			if len(item.Usernames) == 0 || !strings.EqualFold(item.Usernames[0], "john") {
				t.Fatalf("john usernames mismatch: %#v", item.Usernames)
			}
		}
	}
	if !foundJohn {
		t.Fatalf("expected John snapshot item")
	}
	reachableSet := map[string]bool{}
	for _, id := range snap.ReachableIDs {
		reachableSet[id] = true
	}
	for _, id := range []string{"tg:1001", "slack:T001:D002"} {
		if !reachableSet[id] {
			t.Fatalf("expected reachable id %q", id)
		}
	}
}
