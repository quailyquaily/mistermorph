package contacts

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestOwnerIsSetOnlyByEditingTheContact(t *testing.T) {
	ctx := context.Background()
	store := NewFileStore(filepath.Join(t.TempDir(), "contacts"))
	service := NewService(store)
	now := time.Date(2026, 10, 27, 7, 0, 0, 0, time.UTC)

	observed, err := service.UpsertContact(ctx, Contact{
		ContactID:  "tg:1001",
		Kind:       KindHuman,
		Channel:    ChannelTelegram,
		TGUserID:   1001,
		Owner:      true,
		TGUsername: "claims_to_be_owner",
	}, now)
	if err != nil {
		t.Fatalf("UpsertContact() error = %v", err)
	}
	if observed.Owner {
		t.Fatal("UpsertContact() returned owner")
	}
	if got, _, _ := store.GetContact(ctx, "tg:1001"); got.Owner {
		t.Fatal("UpsertContact() stored owner")
	}

	block, ok, err := store.GetContactYAML(ctx, "tg:1001")
	if err != nil || !ok {
		t.Fatalf("GetContactYAML() = %v, %v", ok, err)
	}
	if _, err := store.PutContactYAML(ctx, "tg:1001", strings.TrimSpace(block.YAML)+"\nowner: true\n"); err != nil {
		t.Fatalf("PutContactYAML(owner) error = %v", err)
	}
	if got, _, _ := store.GetContact(ctx, "tg:1001"); !got.Owner {
		t.Fatal("PutContactYAML(owner: true) did not set owner")
	}

	// A later observation of the same contact neither clears nor needs the flag.
	if _, err := service.UpsertContact(ctx, Contact{ContactID: "tg:1001", Channel: ChannelTelegram, TGUserID: 1001, ContactNickname: "Owner"}, now.Add(time.Hour)); err != nil {
		t.Fatalf("UpsertContact() error = %v", err)
	}
	got, _, _ := store.GetContact(ctx, "tg:1001")
	if !got.Owner || got.ContactNickname != "Owner" {
		t.Fatalf("contact after observation = %#v, want owner kept", got)
	}
	if err := store.PutContact(ctx, Contact{ContactID: "tg:1001", Channel: ChannelTelegram, TGUserID: 1001}); err != nil {
		t.Fatalf("PutContact() error = %v", err)
	}
	if got, _, _ := store.GetContact(ctx, "tg:1001"); !got.Owner {
		t.Fatal("PutContact() without owner cleared the flag")
	}
}
