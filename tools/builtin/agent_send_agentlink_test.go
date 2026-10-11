package builtin

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/agentlink"
)

func TestAgentSendOverAgentLink(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stateDir := t.TempDir()
	node, err := agentlink.Shared(agentlink.Options{StateDir: stateDir})
	if err != nil {
		t.Fatal(err)
	}
	peer, err := agentlink.NewNode(agentlink.Options{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	var mu sync.Mutex
	var received []agentlink.Message
	peer.SetHandler(func(_ context.Context, msg agentlink.Message) error {
		mu.Lock()
		received = append(received, msg)
		mu.Unlock()
		return nil
	})
	relay := agentlink.NewRelay(nil)
	for _, n := range []*agentlink.Node{node, peer} {
		a, b := agentlink.Pipe()
		go func(n *agentlink.Node) { _ = n.Serve(ctx, a) }(n)
		go func() { _ = relay.Serve(ctx, b, "test") }()
	}
	deadline := time.Now().Add(5 * time.Second)
	for !node.Reachable(peer.InstanceID()) {
		if time.Now().After(deadline) {
			t.Fatal("peer never became reachable")
		}
		time.Sleep(5 * time.Millisecond)
	}

	contactsDir := filepath.Join(stateDir, "contacts")
	peerContact := agentlink.ContactID(peer.InstanceID())
	if err := contacts.NewFileStore(contactsDir).PutContact(ctx, contacts.Contact{
		ContactID: peerContact, Kind: contacts.KindAgent, Channel: contacts.ChannelAgentLink, ContactNickname: "Peer",
	}); err != nil {
		t.Fatal(err)
	}
	tool := NewAgentSendTool(ContactsSendToolOptions{Enabled: true, ContactsDir: contactsDir, StateDir: stateDir})

	// A task an Agent Link message with hop 2 started sends with hop 3.
	out, err := tool.Execute(agentlink.WithIncomingHop(ctx, 2), map[string]any{"contact_id": peerContact, "message_text": "hello peer"})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if !strings.Contains(out, `"accepted": true`) {
		t.Fatalf("Execute() = %s, want accepted", out)
	}
	mu.Lock()
	got := append([]agentlink.Message(nil), received...)
	mu.Unlock()
	if len(got) != 1 || got[0].Envelope.Text != "hello peer" || got[0].Hop != 3 || got[0].From != node.InstanceID() {
		t.Fatalf("received = %+v", got)
	}

	// Without a cooldown, contacts_send reaches the same agent again; without an incoming hop the
	// message starts a new chain.
	if _, err := NewContactsSendTool(ContactsSendToolOptions{Enabled: true, ContactsDir: contactsDir, StateDir: stateDir}).Execute(ctx, map[string]any{
		"contact_id": peerContact, "message_text": "again",
	}); err != nil {
		t.Fatalf("contacts_send Execute() error = %v", err)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(received) != 2 || received[1].Hop != 1 {
		t.Fatalf("received = %+v", received)
	}
}
