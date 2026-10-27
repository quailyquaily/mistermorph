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

func TestSetOwnerKeepsTheRestOfTheYAML(t *testing.T) {
	ctx := context.Background()
	store := NewFileStore(filepath.Join(t.TempDir(), "contacts"))
	if _, err := NewService(store).UpsertContact(ctx, Contact{
		ContactID: "tg:1002", Kind: KindHuman, Channel: ChannelTelegram, TGUserID: 1002, ContactNickname: "Me",
	}, time.Date(2026, 10, 27, 7, 0, 0, 0, time.UTC)); err != nil {
		t.Fatalf("UpsertContact() error = %v", err)
	}
	before, _, _ := store.GetContactYAML(ctx, "tg:1002")

	for _, tc := range []struct {
		name  string
		owner bool
	}{
		{"mark", true},
		{"mark again", true},
		{"unmark", false},
		{"unmark again", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			block, ok, err := store.SetOwner(ctx, "tg:1002", tc.owner)
			if err != nil || !ok {
				t.Fatalf("SetOwner() = %v, %v", ok, err)
			}
			got, _, _ := store.GetContact(ctx, "tg:1002")
			if got.Owner != tc.owner || got.ContactNickname != "Me" || got.TGUserID != 1002 {
				t.Fatalf("contact = %#v, want owner %v and the rest kept", got, tc.owner)
			}
			if strings.Count(block.YAML, "owner:") > 1 {
				t.Fatalf("yaml has owner twice:\n%s", block.YAML)
			}
		})
	}
	after, _, _ := store.GetContactYAML(ctx, "tg:1002")
	if strings.TrimSpace(after.YAML) != strings.TrimSpace(before.YAML) {
		t.Fatalf("yaml after mark and unmark =\n%s\nwant\n%s", after.YAML, before.YAML)
	}
	if _, ok, err := store.SetOwner(ctx, "tg:missing", true); ok || err != nil {
		t.Fatalf("SetOwner(missing) = %v, %v, want not found", ok, err)
	}
}
