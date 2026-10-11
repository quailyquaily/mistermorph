package builtin

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/agentlink"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
)

// linkedPeer is an agent on the other end of Agent Link that answers each message with answer,
// unless answer is empty.
type linkedPeer struct {
	node *agentlink.Node

	mu       sync.Mutex
	received []agentlink.Message
	answer   string
}

func (p *linkedPeer) handle(_ context.Context, msg agentlink.Message) error {
	p.mu.Lock()
	p.received = append(p.received, msg)
	answer := p.answer
	p.mu.Unlock()
	if answer != "" && msg.Envelope.ReplyTo == "" {
		go func() {
			_, _ = p.node.Send(context.Background(), msg.From, busruntime.MessageEnvelope{
				Text: answer + ": " + msg.Envelope.Text, SessionID: msg.Envelope.SessionID, ReplyTo: msg.MessageID,
			}, msg.Hop+1, 0)
		}()
	}
	return nil
}

func (p *linkedPeer) messages() []agentlink.Message {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]agentlink.Message(nil), p.received...)
}

func (p *linkedPeer) setAnswer(answer string) {
	p.mu.Lock()
	p.answer = answer
	p.mu.Unlock()
}

func TestAgentSendOverAgentLink(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stateDir := t.TempDir()
	node, err := agentlink.Shared(agentlink.Options{StateDir: stateDir})
	if err != nil {
		t.Fatal(err)
	}
	peerNode, err := agentlink.NewNode(agentlink.Options{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer peerNode.Close()
	peer := &linkedPeer{node: peerNode, answer: "pong"}
	peerNode.SetHandler(peer.handle)
	relay := agentlink.NewRelay(nil)
	for _, n := range []*agentlink.Node{node, peerNode} {
		a, b := agentlink.Pipe()
		go func(n *agentlink.Node) { _ = n.Serve(ctx, a) }(n)
		go func() { _ = relay.Serve(ctx, b, "test") }()
	}
	deadline := time.Now().Add(5 * time.Second)
	for !node.Reachable(peerNode.InstanceID()) {
		if time.Now().After(deadline) {
			t.Fatal("peer never became reachable")
		}
		time.Sleep(5 * time.Millisecond)
	}

	contactsDir := filepath.Join(stateDir, "contacts")
	peerContact := agentlink.ContactID(peerNode.InstanceID())
	// putContact (re)writes the peer's contact, which clears its cooldown.
	putContact := func(t *testing.T) {
		t.Helper()
		if err := contacts.NewFileStore(contactsDir).PutContact(ctx, contacts.Contact{
			ContactID: peerContact, Kind: contacts.KindAgent, Channel: contacts.ChannelAgentLink, ContactNickname: "Peer",
		}); err != nil {
			t.Fatal(err)
		}
	}
	putContact(t)
	opts := ContactsSendToolOptions{Enabled: true, ContactsDir: contactsDir, StateDir: stateDir, AgentSendCooldown: time.Hour, AgentLinkReplyTimeout: 5 * time.Second}
	topicCtx := topiccontext.WithScope(ctx, topiccontext.Scope{Runtime: "console", ConversationKey: "console:topic-1", TopicID: "topic-1"})
	send := func(t *testing.T, ctx context.Context, opts ContactsSendToolOptions, text string) map[string]any {
		t.Helper()
		out, err := NewAgentSendTool(opts).Execute(ctx, map[string]any{"contact_id": peerContact, "message_text": text})
		if err != nil {
			t.Fatalf("Execute(%q) error = %v", text, err)
		}
		var result map[string]any
		if err := json.Unmarshal([]byte(out), &result); err != nil {
			t.Fatalf("Execute(%q) = %s: %v", text, out, err)
		}
		return result
	}
	reply := func(result map[string]any) map[string]any {
		r, _ := result["reply"].(map[string]any)
		return r
	}

	t.Run("returns the agent's answer and shows the exchange", func(t *testing.T) {
		var mu sync.Mutex
		var events []agent.Event
		eventsCtx := agent.WithEventSinkContext(topicCtx, agent.EventSinkFunc(func(_ context.Context, e agent.Event) {
			mu.Lock()
			events = append(events, e)
			mu.Unlock()
		}))
		result := send(t, eventsCtx, opts, "what is your name?")
		if r := reply(result); r["status"] != "replied" || r["text"] != "pong: what is your name?" || r["from"] != "Peer" {
			t.Fatalf("reply = %#v", r)
		}
		got := peer.messages()
		if len(got) != 1 || got[0].Hop != 1 || got[0].From != node.InstanceID() {
			t.Fatalf("received = %+v", got)
		}
		mu.Lock()
		defer mu.Unlock()
		var streams []string
		for _, e := range events {
			if e.Kind == agent.EventKindToolOutput && e.ToolName == "agent_send" {
				streams = append(streams, e.Stream+"="+e.Text)
			}
		}
		want := []string{AgentLinkStreamSent + "=what is your name?", AgentLinkStreamReply + "=pong: what is your name?"}
		if strings.Join(streams, "|") != strings.Join(want, "|") {
			t.Fatalf("events = %v, want %v", streams, want)
		}
	})

	t.Run("a follow-up from a person's task skips the cooldown and keeps the session", func(t *testing.T) {
		result := send(t, topicCtx, opts, "and your model?")
		if r := reply(result); r["status"] != "replied" {
			t.Fatalf("reply = %#v", r)
		}
		got := peer.messages()
		if len(got) != 2 || got[1].Envelope.SessionID != got[0].Envelope.SessionID {
			t.Fatalf("received = %+v, want two messages in one session", got)
		}
	})

	t.Run("a task another agent started keeps the cooldown", func(t *testing.T) {
		_, err := NewAgentSendTool(opts).Execute(agentlink.WithIncomingHop(topicCtx, 2), map[string]any{"contact_id": peerContact, "message_text": "loop?"})
		if err == nil || !strings.Contains(err.Error(), "cooling down") {
			t.Fatalf("Execute() error = %v, want cooling down", err)
		}
	})

	t.Run("an answer after the wait finds the conversation that asked", func(t *testing.T) {
		peer.setAnswer("")
		short := opts
		short.AgentLinkReplyTimeout = 50 * time.Millisecond
		result := send(t, topicCtx, short, "take your time")
		if r := reply(result); r["status"] != "pending" {
			t.Fatalf("reply = %#v, want pending", r)
		}
		asked := peer.messages()[2]
		late := agentlink.Message{From: peerNode.InstanceID(), Envelope: busruntime.MessageEnvelope{ReplyTo: asked.MessageID}}
		origin, ok := node.AskOrigin(late)
		if !ok || origin.ConversationKey != "console:topic-1" || origin.TopicID != "topic-1" {
			t.Fatalf("AskOrigin() = %+v, %v", origin, ok)
		}
		if _, ok := node.AskOrigin(late); ok {
			t.Fatal("AskOrigin() found the conversation twice")
		}
	})

	t.Run("contacts_send does not wait for an answer", func(t *testing.T) {
		peer.setAnswer("pong")
		putContact(t)
		out, err := NewContactsSendTool(ContactsSendToolOptions{Enabled: true, ContactsDir: contactsDir, StateDir: stateDir}).Execute(ctx, map[string]any{
			"contact_id": peerContact, "message_text": "fyi",
		})
		if err != nil {
			t.Fatalf("contacts_send Execute() error = %v", err)
		}
		if strings.Contains(out, `"reply"`) {
			t.Fatalf("contacts_send = %s, want no reply", out)
		}
	})
}
