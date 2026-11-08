package memories

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/audience"
)

const legacyContacts = "---\ncreated_at: \"2026-01-01T00:00:00Z\"\nupdated_at: \"2026-01-01T00:00:00Z\"\n---\n\n# Active Contacts\n\n## Alice\n\n```yaml\n" +
	"contact_id: \"tg:@alice\"\nnickname: \"Alice\"\nkind: \"human\"\nchannel: \"telegram\"\ntg_username: \"alice\"\n" +
	"persona_brief: \"core maintainer, terse\"\ntopic_preferences:\n  - \"golang\"\n  - \"release\"\n```\n"

func writeLegacyContacts(t *testing.T) (*contacts.DBStore, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "contacts")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "ACTIVE.md")
	if err := os.WriteFile(path, []byte(legacyContacts), 0o600); err != nil {
		t.Fatal(err)
	}
	return contacts.NewStore(dir), path
}

func TestMoveContactProfiles(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	store, path := writeLegacyContacts(t)

	// The import keeps the legacy fields out of the contact and in agent.db, for the move.
	svc := contacts.NewService(store)
	if _, err := svc.UpsertContact(ctx, contacts.Contact{ContactID: "tg:@alice", Channel: contacts.ChannelTelegram, ContactNickname: "Alice A."}, time.Now()); err != nil {
		t.Fatalf("UpsertContact() error = %v", err)
	}
	if _, err := os.Stat(path + ".imported"); err != nil {
		t.Fatalf("contacts file not imported: %v", err)
	}
	block, _, err := store.GetContactYAML(ctx, "tg:@alice")
	if err != nil || strings.Contains(block.YAML, "persona_brief") {
		t.Fatalf("contact YAML = %q, %v", block.YAML, err)
	}

	moved, err := s.MoveContactProfiles(ctx, store)
	if err != nil || moved != 2 {
		t.Fatalf("MoveContactProfiles() = %d, %v; want 2", moved, err)
	}
	items, _, err := s.Search(ctx, audience.Owner(), SearchOptions{Subject: "contact:tg:@alice"})
	if err != nil || len(items) != 2 {
		t.Fatalf("memories about alice = %#v, %v", items, err)
	}
	for _, m := range items {
		if m.Visibility != VisibilityPrivate || m.LearnedIn != "owner" || m.Type != TypePerson {
			t.Fatalf("moved memory = %#v, want private, from the owner, person", m)
		}
	}
	if found, _, _ := s.Search(ctx, audience.Contact("tg:@alice"), SearchOptions{Query: "maintainer"}); len(found) != 0 {
		t.Fatal("alice hears the owner's note about her")
	}
	if contact, ok, _ := store.GetContact(ctx, "tg:@alice"); !ok || contact.ContactNickname != "Alice A." {
		t.Fatalf("contact after the move = %+v", contact)
	}

	// Nothing is moved twice.
	if moved, err := s.MoveContactProfiles(ctx, store); err != nil || moved != 0 {
		t.Fatalf("second MoveContactProfiles() = %d, %v", moved, err)
	}
}

func TestMoveContactProfilesKeepsFieldsWhenSavingFails(t *testing.T) {
	ctx := context.Background()
	s := openTestStore(t)
	store, _ := writeLegacyContacts(t)
	_ = s.db.Close()
	if _, err := s.MoveContactProfiles(ctx, store); err == nil {
		t.Fatal("MoveContactProfiles() on a closed store error = nil")
	}
	// A working store moves them all later.
	again := openTestStore(t)
	if moved, err := again.MoveContactProfiles(ctx, store); err != nil || moved != 2 {
		t.Fatalf("MoveContactProfiles() after the failure = %d, %v; want 2", moved, err)
	}
}
