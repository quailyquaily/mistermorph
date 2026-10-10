package agentlink

import (
	"context"
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
		s := &contactSync{
			node:  node,
			store: contacts.NewFileStore(filepath.Join(t.TempDir(), "contacts")),
			opts: ContactSyncOptions{
				InactiveAfter: time.Hour,
				Now:           func() time.Time { return now },
			},
			logger:  node.logger,
			path:    filepath.Join(node.dir, "peers.json"),
			records: peerRecords{Peers: map[string]*peerRecord{}},
		}
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
