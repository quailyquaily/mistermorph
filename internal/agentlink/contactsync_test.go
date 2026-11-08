package agentlink

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
)

func TestContactSync(t *testing.T) {
	ctx := context.Background()
	const bob = "inst_0123456789abcdef0123456789abcdef"
	bobContact := ContactID(bob)

	newSync := func(t *testing.T) (*contactSync, *time.Time) {
		t.Helper()
		node := newTestNode(t, "Alice")
		now := time.Date(2026, 10, 11, 9, 0, 0, 0, time.UTC)
		s := newContactSync(node, ContactSyncOptions{
			ContactsDir:   filepath.Join(t.TempDir(), "contacts"),
			InactiveAfter: time.Hour,
			Now:           func() time.Time { return now },
		}, node.logger)
		return s, &now
	}
	status := func(t *testing.T, s *contactSync) contacts.Status {
		t.Helper()
		block, ok, err := s.store.GetContactYAML(ctx, bobContact)
		if err != nil || !ok {
			t.Fatalf("GetContactYAML() = %v, %v", ok, err)
		}
		return block.Status
	}

	t.Run("adds a reachable agent as an active contact", func(t *testing.T) {
		s, _ := newSync(t)
		s.apply(ctx, []Peer{{InstanceID: bob, AgentName: "Bob"}})
		contact, ok, err := s.store.GetContact(ctx, bobContact)
		if err != nil || !ok {
			t.Fatalf("GetContact() = %v, %v", ok, err)
		}
		if contact.Kind != contacts.KindAgent || contact.Channel != contacts.ChannelAgentLink || contact.ContactNickname != "Bob" {
			t.Fatalf("contact = %+v", contact)
		}
		if got := status(t, s); got != contacts.StatusActive {
			t.Fatalf("status = %s, want active", got)
		}
		s.apply(ctx, []Peer{{InstanceID: bob, AgentName: "Robert"}})
		contact, _, _ = s.store.GetContact(ctx, bobContact)
		if contact.ContactNickname != "Robert" {
			t.Fatalf("nickname = %q after rename, want Robert", contact.ContactNickname)
		}
	})

	t.Run("deactivates after inactive_after and reactivates on return", func(t *testing.T) {
		s, now := newSync(t)
		s.apply(ctx, []Peer{{InstanceID: bob, AgentName: "Bob"}})
		*now = now.Add(30 * time.Minute)
		s.apply(ctx, nil)
		if got := status(t, s); got != contacts.StatusActive {
			t.Fatalf("status = %s before inactive_after, want active", got)
		}
		*now = now.Add(time.Hour)
		s.apply(ctx, nil)
		if got := status(t, s); got != contacts.StatusInactive {
			t.Fatalf("status = %s after inactive_after, want inactive", got)
		}
		s.apply(ctx, []Peer{{InstanceID: bob, AgentName: "Bob"}})
		if got := status(t, s); got != contacts.StatusActive {
			t.Fatalf("status = %s after return, want active", got)
		}
	})

	t.Run("keeps a contact a person deactivated", func(t *testing.T) {
		s, _ := newSync(t)
		s.apply(ctx, []Peer{{InstanceID: bob, AgentName: "Bob"}})
		if _, err := s.store.SetContactStatus(ctx, bobContact, contacts.StatusInactive); err != nil {
			t.Fatal(err)
		}
		s.apply(ctx, []Peer{{InstanceID: bob, AgentName: "Bob"}})
		if got := status(t, s); got != contacts.StatusInactive {
			t.Fatalf("status = %s, want the manual inactive kept", got)
		}
	})
}

func TestContactSyncImportsPeersAndReactivatesOnlyItsOwn(t *testing.T) {
	ctx := context.Background()
	const synced = "inst_00000000000000000000000000000001"
	const manual = "inst_00000000000000000000000000000002"
	stateDir := t.TempDir()
	contactsDir := filepath.Join(stateDir, "contacts")
	if err := os.MkdirAll(filepath.Join(stateDir, "agentlink"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(contactsDir, 0o700); err != nil {
		t.Fatal(err)
	}
	inactive := "# Inactive Contacts\n\n## A\n\n```yaml\ncontact_id: \"" + ContactID(synced) + "\"\nkind: \"agent\"\nchannel: \"agentlink\"\n```\n" +
		"\n## B\n\n```yaml\ncontact_id: \"" + ContactID(manual) + "\"\nkind: \"agent\"\nchannel: \"agentlink\"\n```\n"
	if err := os.WriteFile(filepath.Join(contactsDir, "INACTIVE.md"), []byte(inactive), 0o600); err != nil {
		t.Fatal(err)
	}
	peers := `{"peers":{"` + synced + `":{"agent_name":"A","last_seen":"2026-10-01T00:00:00Z","deactivated_by_sync":true},` +
		`"` + manual + `":{"agent_name":"B","last_seen":"2026-10-01T00:00:00Z"}}}`
	if err := os.WriteFile(filepath.Join(stateDir, "agentlink", "peers.json"), []byte(peers), 0o600); err != nil {
		t.Fatal(err)
	}
	node := newTestNode(t, "Alice")
	now := time.Date(2026, 10, 11, 9, 0, 0, 0, time.UTC)
	s := newContactSync(node, ContactSyncOptions{ContactsDir: contactsDir, InactiveAfter: time.Hour, Now: func() time.Time { return now }}, node.logger)
	if err := s.load(ctx); err != nil {
		t.Fatal(err)
	}
	if len(s.peers) != 2 || s.peers[synced].AgentName != "A" {
		t.Fatalf("peers = %+v", s.peers)
	}
	if _, by, _, _ := s.store.ContactStatus(ctx, ContactID(synced)); by != contacts.DeactivatedByAgentLink {
		t.Fatalf("synced contact deactivated_by = %q", by)
	}
	if _, err := os.Stat(filepath.Join(stateDir, "agentlink", "peers.json.imported")); err != nil {
		t.Fatalf("peers.json not renamed: %v", err)
	}
	s.apply(ctx, []Peer{{InstanceID: synced, AgentName: "A"}, {InstanceID: manual, AgentName: "B"}})
	if status, _, _, _ := s.store.ContactStatus(ctx, ContactID(synced)); status != contacts.StatusActive {
		t.Fatalf("contact the sync deactivated = %s, want active again", status)
	}
	if status, _, _, _ := s.store.ContactStatus(ctx, ContactID(manual)); status != contacts.StatusInactive {
		t.Fatalf("contact a person deactivated = %s, want inactive", status)
	}
	// The sync's rows are in agentlink_peers.
	reloaded := newContactSync(node, ContactSyncOptions{ContactsDir: contactsDir}, node.logger)
	if err := reloaded.load(ctx); err != nil || !reloaded.peers[synced].LastSeen.Equal(now) {
		t.Fatalf("reloaded = %+v, %v", reloaded.peers[synced], err)
	}
}
