package agentlink

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
)

func newTestNode(t *testing.T, name string) *Node {
	t.Helper()
	node, err := NewNode(Options{StateDir: t.TempDir(), AgentName: func() string { return name }, LeaseTimeout: 200 * time.Millisecond})
	if err != nil {
		t.Fatalf("NewNode() error = %v", err)
	}
	node.retryBase = 10 * time.Millisecond
	t.Cleanup(node.Close)
	return node
}

// attach connects node to relay in process and returns a function that disconnects it.
func attach(t *testing.T, ctx context.Context, node *Node, relay *Relay, label string) (disconnect func(), relayErr <-chan error) {
	t.Helper()
	ctx, cancel := context.WithCancel(ctx)
	a, b := Pipe()
	errs := make(chan error, 1)
	go func() { _ = node.Serve(ctx, a) }()
	go func() { errs <- relay.Serve(ctx, b, label) }()
	return cancel, errs
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func envelope(text string) busruntime.MessageEnvelope {
	return busruntime.MessageEnvelope{Text: text, SessionID: "0194d8f0-0000-7000-8000-000000000000"}
}

type inbox struct {
	mu   sync.Mutex
	msgs []Message
}

func (i *inbox) handler(err error) Handler {
	return func(_ context.Context, msg Message) error {
		if err != nil {
			return err
		}
		i.mu.Lock()
		i.msgs = append(i.msgs, msg)
		i.mu.Unlock()
		return nil
	}
}

func (i *inbox) count() int {
	i.mu.Lock()
	defer i.mu.Unlock()
	return len(i.msgs)
}

func TestNodeRelayDelivery(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	t.Run("delivers between two runtimes", func(t *testing.T) {
		relay := NewRelay(nil)
		a, b := newTestNode(t, "Alice"), newTestNode(t, "Bob")
		var got inbox
		b.SetHandler(got.handler(nil))
		attach(t, ctx, a, relay, "a")
		attach(t, ctx, b, relay, "b")
		waitFor(t, "roster", func() bool { return a.Reachable(b.InstanceID()) })
		if peers := a.Peers(); len(peers) != 1 || peers[0].AgentName != "Bob" {
			t.Fatalf("a.Peers() = %+v, want only Bob", peers)
		}

		res, err := a.Send(ctx, b.InstanceID(), envelope("hello"), 1, 5*time.Second)
		if err != nil {
			t.Fatalf("Send() error = %v", err)
		}
		if res.Status != StatusDelivered {
			t.Fatalf("Send() status = %q, want delivered", res.Status)
		}
		if got.count() != 1 || got.msgs[0].From != a.InstanceID() || got.msgs[0].Envelope.Text != "hello" {
			t.Fatalf("delivered = %+v", got.msgs)
		}
	})

	t.Run("a rejection reaches the sender", func(t *testing.T) {
		relay := NewRelay(nil)
		a, b := newTestNode(t, "A"), newTestNode(t, "B")
		b.SetHandler((&inbox{}).handler(&RejectError{Reason: ReasonHopLimit}))
		attach(t, ctx, a, relay, "a")
		attach(t, ctx, b, relay, "b")
		waitFor(t, "roster", func() bool { return a.Reachable(b.InstanceID()) })
		res, err := a.Send(ctx, b.InstanceID(), envelope("hi"), 7, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != StatusRejected || res.Reason != ReasonHopLimit {
			t.Fatalf("Send() = %+v, want rejected hop_limit", res)
		}
	})

	t.Run("queues until the target connects", func(t *testing.T) {
		relay := NewRelay(nil)
		a, b := newTestNode(t, "A"), newTestNode(t, "B")
		var got inbox
		b.SetHandler(got.handler(nil))
		attach(t, ctx, a, relay, "a")
		res, err := a.Send(ctx, b.InstanceID(), envelope("later"), 1, 50*time.Millisecond)
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != StatusQueued {
			t.Fatalf("Send() status = %q, want queued", res.Status)
		}
		attach(t, ctx, b, relay, "b")
		waitFor(t, "delivery", func() bool { return got.count() == 1 })
	})

	t.Run("two consoles deliver once", func(t *testing.T) {
		r1, r2 := NewRelay(nil), NewRelay(nil)
		a, b := newTestNode(t, "A"), newTestNode(t, "B")
		var got inbox
		b.SetHandler(got.handler(nil))
		attach(t, ctx, a, r1, "a1")
		attach(t, ctx, a, r2, "a2")
		attach(t, ctx, b, r1, "b1")
		attach(t, ctx, b, r2, "b2")
		waitFor(t, "roster", func() bool { return a.Reachable(b.InstanceID()) })
		for i := 0; i < 5; i++ {
			if res, err := a.Send(ctx, b.InstanceID(), envelope("x"), 1, 5*time.Second); err != nil || res.Status != StatusDelivered {
				t.Fatalf("Send() = %+v, %v", res, err)
			}
		}
		if got.count() != 5 {
			t.Fatalf("delivered %d messages, want 5", got.count())
		}
		if peers := a.Peers(); len(peers) != 1 {
			t.Fatalf("a.Peers() = %+v, want B once", peers)
		}
	})

	t.Run("a repeated message is accepted once", func(t *testing.T) {
		relay := NewRelay(nil)
		a, b := newTestNode(t, "A"), newTestNode(t, "B")
		var got inbox
		b.SetHandler(got.handler(nil))
		attach(t, ctx, a, relay, "a")
		attach(t, ctx, b, relay, "b")
		waitFor(t, "roster", func() bool { return a.Reachable(b.InstanceID()) })
		env := envelope("once")
		env.MessageID = "msg_fixed"
		for i := 0; i < 2; i++ {
			if res, err := a.Send(ctx, b.InstanceID(), env, 1, 5*time.Second); err != nil || res.Status != StatusDelivered {
				t.Fatalf("Send() = %+v, %v", res, err)
			}
		}
		if got.count() != 1 {
			t.Fatalf("handler ran %d times, want 1", got.count())
		}
	})

	t.Run("refuses a second connection with the same instance id", func(t *testing.T) {
		relay := NewRelay(nil)
		a := newTestNode(t, "A")
		attach(t, ctx, a, relay, "first")
		waitFor(t, "member", func() bool { return len(relay.Members()) == 1 })
		_, errs := attach(t, ctx, a, relay, "second")
		select {
		case err := <-errs:
			if !errors.Is(err, ErrDuplicateInstance) {
				t.Fatalf("second Serve() error = %v, want ErrDuplicateInstance", err)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("second Serve() did not return")
		}
	})

	t.Run("roster drops a runtime that disconnects", func(t *testing.T) {
		relay := NewRelay(nil)
		a, b := newTestNode(t, "A"), newTestNode(t, "B")
		attach(t, ctx, a, relay, "a")
		disconnect, _ := attach(t, ctx, b, relay, "b")
		waitFor(t, "roster", func() bool { return a.Reachable(b.InstanceID()) })
		var changes atomic.Int32
		stop := a.Subscribe(func([]Peer) { changes.Add(1) })
		defer stop()
		disconnect()
		waitFor(t, "removal", func() bool { return !a.Reachable(b.InstanceID()) })
		waitFor(t, "notification", func() bool { return changes.Load() >= 2 })
	})
}

// silentConsole takes every message a node offers and never answers.
type silentConsole struct{ sends atomic.Int32 }

func (s *silentConsole) serve(ctx context.Context, conn Conn, roster []Peer) {
	_ = conn.WriteFrame(ctx, Frame{Type: FrameRoster, Agents: roster})
	for {
		frame, err := conn.ReadFrame(ctx)
		if err != nil {
			return
		}
		if frame.Type == FrameSend {
			s.sends.Add(1)
		}
	}
}

func TestNodeLeaseMovesToAnotherConsole(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, b := newTestNode(t, "A"), newTestNode(t, "B")
	var got inbox
	b.SetHandler(got.handler(nil))

	silent := &silentConsole{}
	end1, end2 := Pipe()
	go func() { _ = a.Serve(ctx, end1) }()
	go silent.serve(ctx, end2, []Peer{{InstanceID: b.InstanceID()}})
	waitFor(t, "silent roster", func() bool { return a.Reachable(b.InstanceID()) })

	if res, err := a.Send(ctx, b.InstanceID(), envelope("retry"), 1, 0); err != nil || res.Status != StatusQueued {
		t.Fatalf("Send() = %+v, %v", res, err)
	}
	waitFor(t, "first lease", func() bool { return silent.sends.Load() >= 1 })

	relay := NewRelay(nil)
	attach(t, ctx, a, relay, "a")
	attach(t, ctx, b, relay, "b")
	waitFor(t, "delivery through the second console", func() bool { return got.count() == 1 })
}

func TestNodeQueueTTLAndPersistence(t *testing.T) {
	ctx := context.Background()

	t.Run("expires", func(t *testing.T) {
		node, err := NewNode(Options{StateDir: t.TempDir(), QueueTTL: 50 * time.Millisecond})
		if err != nil {
			t.Fatal(err)
		}
		defer node.Close()
		other := newTestNode(t, "B")
		res, err := node.Send(ctx, other.InstanceID(), envelope("lost"), 1, 3*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != StatusExpired {
			t.Fatalf("Send() status = %q, want expired", res.Status)
		}
	})

	t.Run("survives a restart", func(t *testing.T) {
		dir := t.TempDir()
		node, err := NewNode(Options{StateDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		b := newTestNode(t, "B")
		if _, err := node.Send(ctx, b.InstanceID(), envelope("kept"), 1, 0); err != nil {
			t.Fatal(err)
		}
		node.Close()

		reopened, err := NewNode(Options{StateDir: dir})
		if err != nil {
			t.Fatal(err)
		}
		defer reopened.Close()
		var got inbox
		b.SetHandler(got.handler(nil))
		runCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		relay := NewRelay(nil)
		attach(t, runCtx, reopened, relay, "a")
		attach(t, runCtx, b, relay, "b")
		waitFor(t, "delivery after restart", func() bool { return got.count() == 1 })
	})

	t.Run("refuses to send to itself", func(t *testing.T) {
		node := newTestNode(t, "A")
		if _, err := node.Send(ctx, node.InstanceID(), envelope("me"), 1, 0); err == nil {
			t.Fatal("expected an error")
		}
	})
}

func TestWebSocketHandler(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a, b := newTestNode(t, "A"), newTestNode(t, "B")
	var got inbox
	b.SetHandler(got.handler(nil))
	const token = "secret"
	authorize := func(r *http.Request) bool { return r.Header.Get("Authorization") == "Bearer "+token }
	server := httptest.NewServer(b.WebSocketHandler(authorize))
	defer server.Close()

	if _, err := Dial(ctx, server.URL, "wrong"); err == nil {
		t.Fatal("Dial() with a wrong token succeeded")
	}
	conn, err := Dial(ctx, server.URL, token)
	if err != nil {
		t.Fatalf("Dial() error = %v", err)
	}
	relay := NewRelay(nil)
	go func() { _ = relay.Serve(ctx, conn, "remote") }()
	attach(t, ctx, a, relay, "local")
	waitFor(t, "roster", func() bool { return a.Reachable(b.InstanceID()) })
	if res, err := a.Send(ctx, b.InstanceID(), envelope("over ws"), 1, 5*time.Second); err != nil || res.Status != StatusDelivered {
		t.Fatalf("Send() = %+v, %v", res, err)
	}
}
