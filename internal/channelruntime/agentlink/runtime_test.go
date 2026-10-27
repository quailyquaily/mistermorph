package agentlink

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/contacts"
	link "github.com/quailyquaily/mistermorph/internal/agentlink"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type stubLLM struct{}

func (stubLLM) Chat(context.Context, llm.Request) (llm.Result, error) {
	return llm.Result{Text: `{"type":"final","output":"pong"}`}, nil
}

type mapReader map[string]string

func (m mapReader) GetString(key string) string { return m[key] }

func testDeps(t *testing.T) depsutil.CommonDependencies {
	t.Helper()
	paths := runtimepaths.FromReader(mapReader{"file_state_dir": t.TempDir(), "file_cache_dir": t.TempDir()})
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	return depsutil.CommonDependencies{
		Logger:          func() (*slog.Logger, error) { return logger, nil },
		LogOptions:      func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) { return llmutil.ResolvedRoute{}, nil },
		CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return stubLLM{}, nil },
		Registry:        func() *tools.Registry { return tools.NewRegistry() },
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
		RuntimePaths: paths,
	}
}

type replies struct {
	mu   sync.Mutex
	msgs []link.Message
}

func (r *replies) handle(_ context.Context, msg link.Message) error {
	r.mu.Lock()
	r.msgs = append(r.msgs, msg)
	r.mu.Unlock()
	return nil
}

func (r *replies) snapshot() []link.Message {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]link.Message(nil), r.msgs...)
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func connect(ctx context.Context, node *link.Node, relay *link.Relay, label string) {
	a, b := link.Pipe()
	go func() { _ = node.Serve(ctx, a) }()
	go func() { _ = relay.Serve(ctx, b, label) }()
}

func TestRunnerAnswersAgentLinkMessages(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	deps := testDeps(t)
	stop := Start(ctx, deps, Options{MaxHops: 3})
	defer stop()
	runner, err := link.Shared(link.Options{StateDir: deps.RuntimePaths.StateDir})
	if err != nil {
		t.Fatal(err)
	}

	sender, err := link.NewNode(link.Options{StateDir: t.TempDir(), AgentName: func() string { return "Asker" }})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	var got replies
	sender.SetHandler(got.handle)

	relay := link.NewRelay(nil)
	connect(ctx, runner, relay, "runner")
	connect(ctx, sender, relay, "sender")
	waitFor(t, "roster", func() bool { return sender.Reachable(runner.InstanceID()) })
	// Start returns before the runtime sets its handler; until then deliveries are rejected.
	waitFor(t, "handler", runner.HasHandler)

	t.Run("answers with a reply one hop further", func(t *testing.T) {
		env := busruntime.MessageEnvelope{Text: "ping", SessionID: "0194d8f0-0000-7000-8000-000000000001"}
		res, err := sender.Send(ctx, runner.InstanceID(), env, 1, 5*time.Second)
		if err != nil || res.Status != link.StatusDelivered {
			t.Fatalf("Send() = %+v, %v", res, err)
		}
		waitFor(t, "reply", func() bool { return len(got.snapshot()) == 1 })
		reply := got.snapshot()[0]
		if reply.Envelope.Text != "pong" || reply.Hop != 2 || reply.Envelope.ReplyTo != res.MessageID || reply.Envelope.SessionID != env.SessionID {
			t.Fatalf("reply = %+v", reply)
		}
	})

	t.Run("records the sender as an Agent contact", func(t *testing.T) {
		store := contacts.NewFileStore(deps.RuntimePaths.ContactsDir)
		waitFor(t, "contact", func() bool {
			contact, ok, err := store.GetContact(ctx, link.ContactID(sender.InstanceID()))
			return err == nil && ok && contact.Kind == contacts.KindAgent && contact.ContactNickname == "Asker"
		})
	})

	t.Run("refuses a message past max_hops", func(t *testing.T) {
		before := len(got.snapshot())
		env := busruntime.MessageEnvelope{Text: "loop", SessionID: "0194d8f0-0000-7000-8000-000000000002"}
		res, err := sender.Send(ctx, runner.InstanceID(), env, 4, 5*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		if res.Status != link.StatusRejected || res.Reason != link.ReasonHopLimit {
			t.Fatalf("Send() = %+v, want rejected hop_limit", res)
		}
		time.Sleep(200 * time.Millisecond)
		if n := len(got.snapshot()); n != before {
			t.Fatalf("got %d replies after a hop-limited message, want %d", n, before)
		}
	})

	t.Run("a second runner for the same state dir does not start", func(t *testing.T) {
		stopSecond := Start(ctx, deps, Options{})
		stopSecond()
		env := busruntime.MessageEnvelope{Text: "still here", SessionID: "0194d8f0-0000-7000-8000-000000000003"}
		if res, err := sender.Send(ctx, runner.InstanceID(), env, 1, 5*time.Second); err != nil || res.Status != link.StatusDelivered {
			t.Fatalf("Send() = %+v, %v", res, err)
		}
	})
}

func TestRunnerHandlesReplies(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	deps := testDeps(t)
	lateReplies := make(chan LateReply, 1)
	stop := Start(ctx, deps, Options{LateReply: func(_ context.Context, reply LateReply) error {
		lateReplies <- reply
		return nil
	}})
	defer stop()
	runner, err := link.Shared(link.Options{StateDir: deps.RuntimePaths.StateDir})
	if err != nil {
		t.Fatal(err)
	}
	sender, err := link.NewNode(link.Options{StateDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	var got replies
	sender.SetHandler(got.handle)
	relay := link.NewRelay(nil)
	connect(ctx, runner, relay, "runner")
	connect(ctx, sender, relay, "sender")
	waitFor(t, "roster", func() bool { return sender.Reachable(runner.InstanceID()) })
	// Start returns before the runtime sets its handler; until then deliveries are rejected.
	waitFor(t, "handler", runner.HasHandler)

	t.Run("an answer that came late goes to the conversation that asked", func(t *testing.T) {
		origin := link.Origin{Runtime: "console", ConversationKey: "console:topic-1", TopicID: "topic-1"}
		_, stopWaiting := runner.ExpectReply("msg_asked", sender.InstanceID(), origin)
		stopWaiting()
		env := busruntime.MessageEnvelope{Text: "late answer", SessionID: "0194d8f0-0000-7000-8000-000000000004", ReplyTo: "msg_asked"}
		if res, err := sender.Send(ctx, runner.InstanceID(), env, 2, 5*time.Second); err != nil || res.Status != link.StatusDelivered {
			t.Fatalf("Send() = %+v, %v", res, err)
		}
		select {
		case reply := <-lateReplies:
			if reply.Origin != origin || reply.Message.Envelope.Text != "late answer" || reply.ContactID != link.ContactID(sender.InstanceID()) {
				t.Fatalf("late reply = %+v", reply)
			}
		case <-time.After(5 * time.Second):
			t.Fatal("the late answer never reached LateReply")
		}
	})

	t.Run("an answer to nothing it knows runs a task but is not answered", func(t *testing.T) {
		env := busruntime.MessageEnvelope{Text: "an answer", SessionID: "0194d8f0-0000-7000-8000-000000000005", ReplyTo: "msg_unknown"}
		if res, err := sender.Send(ctx, runner.InstanceID(), env, 2, 5*time.Second); err != nil || res.Status != link.StatusDelivered {
			t.Fatalf("Send() = %+v, %v", res, err)
		}
		time.Sleep(500 * time.Millisecond)
		if n := len(got.snapshot()); n != 0 {
			t.Fatalf("got %d replies to an answer, want none", n)
		}
	})
}
