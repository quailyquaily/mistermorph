package runtimecontrol

import (
	"context"
	"errors"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
)

type steerReplyLog struct {
	mu      sync.Mutex
	replies []SteerReply
}

func (l *steerReplyLog) deliver(_ context.Context, reply SteerReply) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.replies = append(l.replies, reply)
	return nil
}

func (l *steerReplyLog) all() []SteerReply {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]SteerReply(nil), l.replies...)
}

func startSteerTestLease(t *testing.T, control *RunControl, run ActiveRun) *RunLease {
	t.Helper()
	if run.Runtime == "" {
		run.Runtime = "telegram"
	}
	if run.ConversationKey == "" {
		run.ConversationKey = "chat:1"
	}
	if run.TaskID == "" {
		run.TaskID = "task_1"
	}
	lease, err := control.StartLease(context.Background(), 0, run)
	if err != nil {
		t.Fatalf("StartLease() error = %v", err)
	}
	t.Cleanup(func() { lease.Finish() })
	return lease
}

func TestSteerResponderRepliesWithTaskContextAndKeepsSteering(t *testing.T) {
	control := New()
	lease := startSteerTestLease(t, control, ActiveRun{
		Task:         "Write a report on solar panels",
		Conversation: []ConversationLine{{Role: "user", Text: "I live in Oslo"}, {Role: "assistant", Text: "Noted, Oslo."}},
		Snapshot:     func() string { return "Plan: 1. research (done) 2. draft (running)" },
	})
	var got SteerReplyRequest
	var gotMessages []llm.Message
	client := llmClientFunc(func(_ context.Context, req llm.Request) (llm.Result, error) {
		gotMessages = req.Messages
		if len(req.Tools) != 0 {
			t.Errorf("reply request has tools: %v", req.Tools)
		}
		return llm.Result{Text: "Understood: I'll focus the draft on rooftop panels from here on."}, nil
	})
	responder := NewSteerResponder(context.Background(), func(ctx context.Context, req SteerReplyRequest) (string, error) {
		got = req
		return LLMSteerReplier(client, "test-model")(ctx, req)
	}, SteerResponderOptions{})
	log := &steerReplyLog{}

	result := control.Steer("telegram", "chat:1", "  focus on rooftop panels  ")
	if !result.Found || !result.Queued || result.Answered {
		t.Fatalf("Steer() = %+v, want queued", result)
	}
	if err := responder.Respond(result, log.deliver); err != nil {
		t.Fatalf("Respond() error = %v", err)
	}
	responder.Wait()

	replies := log.all()
	if len(replies) != 1 {
		t.Fatalf("replies = %+v, want one", replies)
	}
	reply := replies[0]
	if reply.Status != SteerReplied || reply.Text != "Understood: I'll focus the draft on rooftop panels from here on." || reply.TaskID != "task_1" || reply.Input != "focus on rooftop panels" {
		t.Fatalf("reply = %+v", reply)
	}
	if got.Task != "Write a report on solar panels" || got.Input != "focus on rooftop panels" || got.Progress == "" || len(got.Conversation) != 2 || got.Answered {
		t.Fatalf("request = %+v", got)
	}
	if len(gotMessages) != 2 || !strings.Contains(gotMessages[0].Content, "never say that it, or the task, is done") {
		t.Fatalf("system prompt = %+v", gotMessages)
	}
	for _, want := range []string{"Write a report on solar panels", "I live in Oslo", "draft (running)", "focus on rooftop panels", "queued for the running task"} {
		if !strings.Contains(gotMessages[1].Content, want) {
			t.Errorf("prompt misses %q:\n%s", want, gotMessages[1].Content)
		}
	}
	// The reply does not take the input's place: the run still gets it.
	if items := lease.SteerQueue.Drain(); len(items) != 1 || items[0] != "focus on rooftop panels" {
		t.Fatalf("steer queue = %#v, want the input", items)
	}
}

func TestSteerResponderKeepsOrderAndRepliesOnce(t *testing.T) {
	control := New()
	startSteerTestLease(t, control, ActiveRun{Task: "Plan a trip"})
	var calls atomic.Int32
	var mu sync.Mutex
	var earlier [][]SteerExchange
	responder := NewSteerResponder(context.Background(), func(_ context.Context, req SteerReplyRequest) (string, error) {
		calls.Add(1)
		mu.Lock()
		earlier = append(earlier, req.Earlier)
		mu.Unlock()
		if req.Input == "first" {
			// The first reply takes longest; the others still wait for it.
			time.Sleep(30 * time.Millisecond)
		}
		return "Reply to " + req.Input, nil
	}, SteerResponderOptions{Concurrency: 3})
	log := &steerReplyLog{}
	for _, input := range []string{"first", "second", "third"} {
		if err := responder.Respond(control.Steer("telegram", "chat:1", input), log.deliver); err != nil {
			t.Fatal(err)
		}
	}
	responder.Wait()

	replies := log.all()
	if len(replies) != 3 || calls.Load() != 3 {
		t.Fatalf("replies = %+v, calls = %d; want three, once each", replies, calls.Load())
	}
	for i, input := range []string{"first", "second", "third"} {
		if replies[i].Input != input || replies[i].Text != "Reply to "+input {
			t.Fatalf("reply %d = %+v, want the reply to %q", i, replies[i], input)
		}
	}
	// Each reply knows the ones before it.
	if len(earlier[2]) != 2 || earlier[2][0].Message != "first" || earlier[2][1].Reply != "Reply to second" {
		t.Fatalf("third reply's earlier exchanges = %+v", earlier[2])
	}
}

func TestSteerResponderExplainsFailures(t *testing.T) {
	cases := []struct {
		name    string
		text    string
		err     error
		wantErr error
	}{
		{name: "llm error", err: errors.New("provider offline")},
		{name: "empty", text: "  ", wantErr: ErrSteerReplyNotMeaningful},
		{name: "emoji only", text: "👌", wantErr: ErrSteerReplyNotMeaningful},
		{name: "emoji and punctuation", text: "👍 ✅!", wantErr: ErrSteerReplyNotMeaningful},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			control := New()
			lease := startSteerTestLease(t, control, ActiveRun{})
			responder := NewSteerResponder(context.Background(), func(context.Context, SteerReplyRequest) (string, error) {
				return tc.text, tc.err
			}, SteerResponderOptions{})
			log := &steerReplyLog{}
			if err := responder.Respond(control.Steer("telegram", "chat:1", "use metric units"), log.deliver); err != nil {
				t.Fatal(err)
			}
			responder.Wait()
			replies := log.all()
			if len(replies) != 1 || replies[0].Status != SteerReplyFailed {
				t.Fatalf("replies = %+v, want one failure", replies)
			}
			reply := replies[0]
			if !strings.Contains(reply.Text, "could not write a reply") || !strings.Contains(reply.Text, "will still take your message in") || !hasWords(reply.Text) {
				t.Fatalf("failure text = %q", reply.Text)
			}
			if tc.err != nil && !strings.Contains(reply.Text, "provider offline") {
				t.Fatalf("failure text %q does not say why", reply.Text)
			}
			if tc.wantErr != nil && !errors.Is(reply.Err, tc.wantErr) {
				t.Fatalf("reply.Err = %v, want %v", reply.Err, tc.wantErr)
			}
			if items := lease.SteerQueue.Drain(); len(items) != 1 {
				t.Fatalf("failed reply lost the steer: %#v", items)
			}
		})
	}
}

func TestSteerResponderWithoutModelSaysSo(t *testing.T) {
	control := New()
	startSteerTestLease(t, control, ActiveRun{})
	log := &steerReplyLog{}
	var responder *SteerResponder
	if err := responder.Respond(control.Steer("telegram", "chat:1", "hello?"), log.deliver); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for len(log.all()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if replies := log.all(); len(replies) != 1 || replies[0].Status != SteerReplyFailed || !strings.Contains(replies[0].Text, "no model is available") {
		t.Fatalf("replies = %+v", replies)
	}
}

func TestSteerResponderExplainsInputThatDidNotReachTheRun(t *testing.T) {
	t.Run("stopping", func(t *testing.T) {
		control := New()
		startSteerTestLease(t, control, ActiveRun{})
		control.Stop("telegram", "chat:1", "/stop")
		assertNotQueuedReply(t, control.Steer("telegram", "chat:1", "also add tests"), SteerRejectedStopping, "being stopped")
	})
	t.Run("full", func(t *testing.T) {
		control := New()
		startSteerTestLease(t, control, ActiveRun{SteerQueue: NewSteerQueue(1)})
		control.Steer("telegram", "chat:1", "one")
		assertNotQueuedReply(t, control.Steer("telegram", "chat:1", "two"), SteerRejectedFull, "Too many")
	})
	t.Run("finishing", func(t *testing.T) {
		control := New()
		lease := startSteerTestLease(t, control, ActiveRun{})
		lease.SteerQueue.DrainAndClose()
		assertNotQueuedReply(t, control.Steer("telegram", "chat:1", "one more thing"), SteerRejectedFinishing, "already finishing")
	})
}

func assertNotQueuedReply(t *testing.T, result SteerResult, reason string, want string) {
	t.Helper()
	if !result.Found || result.Queued || result.Reason != reason {
		t.Fatalf("Steer() = %+v, want not queued for %q", result, reason)
	}
	responder := NewSteerResponder(context.Background(), func(context.Context, SteerReplyRequest) (string, error) {
		t.Error("asked the model about input that did not reach the run")
		return "", nil
	}, SteerResponderOptions{})
	log := &steerReplyLog{}
	if err := responder.Respond(result, log.deliver); err != nil {
		t.Fatal(err)
	}
	responder.Wait()
	if replies := log.all(); len(replies) != 1 || replies[0].Status != SteerNotQueued || !strings.Contains(replies[0].Text, want) || !strings.Contains(replies[0].Text, "not added") {
		t.Fatalf("replies = %+v", replies)
	}
}

func TestSteerResponderRejectsInputThatWasNotSteered(t *testing.T) {
	control := New()
	responder := NewSteerResponder(context.Background(), nil, SteerResponderOptions{})
	log := &steerReplyLog{}
	if result := control.Steer("telegram", "chat:1", "hello"); result.Found {
		t.Fatalf("Steer() without a run = %+v", result)
	} else if err := responder.Respond(result, log.deliver); !errors.Is(err, ErrNoActiveRun) {
		t.Fatalf("Respond(no active run) = %v", err)
	}
	startSteerTestLease(t, control, ActiveRun{})
	if result := control.Steer("telegram", "chat:1", "   "); result.Found {
		t.Fatalf("Steer(empty) = %+v, want not found", result)
	}
	if err := responder.Respond(SteerResult{Found: true, entry: &activeRun{}}, log.deliver); !errors.Is(err, ErrSteerInputEmpty) {
		t.Fatalf("Respond(empty input) = %v", err)
	}
	responder.Wait()
	if replies := log.all(); len(replies) != 0 {
		t.Fatalf("replies = %+v, want none", replies)
	}
}

func TestSteerResponderWhenTheRunEndsWhileTheReplyIsWritten(t *testing.T) {
	for _, mode := range []string{"finished", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			control := New()
			lease := startSteerTestLease(t, control, ActiveRun{})
			writing, release := make(chan struct{}), make(chan struct{})
			responder := NewSteerResponder(context.Background(), func(context.Context, SteerReplyRequest) (string, error) {
				close(writing)
				<-release
				return "I'll switch to the new data source.", nil
			}, SteerResponderOptions{})
			log := &steerReplyLog{}
			if err := responder.Respond(control.Steer("telegram", "chat:1", "use the new data source"), log.deliver); err != nil {
				t.Fatal(err)
			}
			<-writing
			if mode == "stopped" {
				control.Stop("telegram", "chat:1", "/stop")
			}
			lease.Finish()
			close(release)
			responder.Wait()
			replies := log.all()
			if len(replies) != 1 || replies[0].Status != SteerNotApplied || strings.Contains(replies[0].Text, "switch") {
				t.Fatalf("replies = %+v, want only a not-applied notice", replies)
			}
			want := "ended before"
			if mode == "stopped" {
				want = "stopped before"
			}
			if !strings.Contains(replies[0].Text, want) {
				t.Fatalf("notice = %q, want %q", replies[0].Text, want)
			}
		})
	}
}

func TestSteerResponderTellsWhenTheRunDropsInputAfterTheReply(t *testing.T) {
	for _, mode := range []string{"applied", "dropped", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			control := New()
			lease := startSteerTestLease(t, control, ActiveRun{})
			responder := NewSteerResponder(context.Background(), func(context.Context, SteerReplyRequest) (string, error) {
				return "I'll add a summary table at the end.", nil
			}, SteerResponderOptions{})
			log := &steerReplyLog{}
			delivered := make(chan struct{}, 4)
			if err := responder.Respond(control.Steer("telegram", "chat:1", "add a summary table"), func(ctx context.Context, reply SteerReply) error {
				defer func() { delivered <- struct{}{} }()
				return log.deliver(ctx, reply)
			}); err != nil {
				t.Fatal(err)
			}
			<-delivered
			switch mode {
			case "applied":
				lease.SteerQueue.Drain()
				lease.Finish()
			case "dropped":
				lease.Finish()
			case "stopped":
				control.Stop("telegram", "chat:1", "/stop")
				lease.Finish()
			}
			responder.Wait()
			responder.watchers.Wait()
			replies := log.all()
			if len(replies) == 0 || replies[0].Status != SteerReplied || replies[0].Followup {
				t.Fatalf("replies = %+v, want the reply first", replies)
			}
			if mode != "dropped" {
				if len(replies) != 1 {
					t.Fatalf("replies = %+v, want just the reply", replies)
				}
				return
			}
			if len(replies) != 2 || !replies[1].Followup || replies[1].Status != SteerNotApplied || !strings.Contains(replies[1].Text, "add a summary table") {
				t.Fatalf("replies = %+v, want a follow-up notice", replies)
			}
		})
	}
}

// The run can end while the reply is being delivered: after the reply was checked against the
// ticket, but before its delivery returns. The input it promised is then dropped, and the person
// must still be told so.
func TestSteerResponderTellsWhenTheRunDropsInputDuringDelivery(t *testing.T) {
	for _, mode := range []string{"applied", "dropped", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			control := New()
			lease := startSteerTestLease(t, control, ActiveRun{})
			responder := NewSteerResponder(context.Background(), func(context.Context, SteerReplyRequest) (string, error) {
				return "I'll add a summary table at the end.", nil
			}, SteerResponderOptions{})
			log := &steerReplyLog{}
			var deliveries atomic.Int32
			if err := responder.Respond(control.Steer("telegram", "chat:1", "add a summary table"), func(ctx context.Context, reply SteerReply) error {
				if deliveries.Add(1) == 1 {
					// The first delivery, the reply itself, is still in flight when the run ends.
					switch mode {
					case "applied":
						lease.SteerQueue.Drain()
						lease.Finish()
					case "dropped":
						lease.Finish()
					case "stopped":
						control.Stop("telegram", "chat:1", "/stop")
						lease.Finish()
					}
				}
				return log.deliver(ctx, reply)
			}); err != nil {
				t.Fatal(err)
			}
			responder.Wait()
			responder.watchers.Wait()
			replies := log.all()
			if len(replies) == 0 || replies[0].Status != SteerReplied || replies[0].Followup {
				t.Fatalf("replies = %+v, want the reply first", replies)
			}
			if mode != "dropped" {
				if len(replies) != 1 {
					t.Fatalf("replies = %+v, want just the reply", replies)
				}
				return
			}
			if len(replies) != 2 || !replies[1].Followup || replies[1].Status != SteerNotApplied || !strings.Contains(replies[1].Text, "add a summary table") {
				t.Fatalf("replies = %+v, want a follow-up notice after the reply", replies)
			}
		})
	}
}

func TestSteerResponderRepliesToAnAnswer(t *testing.T) {
	control := New()
	lease := startSteerTestLease(t, control, ActiveRun{Task: "Book a table"})
	question, err := lease.OpenQuestionText("q1", "Which evening suits you?", []string{"Friday", "Saturday"}, false)
	if err != nil {
		t.Fatal(err)
	}
	defer question.Close()
	var got SteerReplyRequest
	responder := NewSteerResponder(context.Background(), func(_ context.Context, req SteerReplyRequest) (string, error) {
		got = req
		return "Sunday it is; I'll look for a table that evening.", nil
	}, SteerResponderOptions{})
	log := &steerReplyLog{}
	result := control.Steer("telegram", "chat:1", "Sunday instead")
	if !result.Answered || result.Ticket() != nil {
		t.Fatalf("Steer() = %+v, want an answer", result)
	}
	if err := responder.Respond(result, log.deliver); err != nil {
		t.Fatal(err)
	}
	answer, err := question.Wait(context.Background())
	if err != nil || answer.Text != "Sunday instead" || !answer.Typed() {
		t.Fatalf("answer = %+v, %v", answer, err)
	}
	responder.Wait()
	if !got.Answered || got.Question != "Which evening suits you?" || got.Input != "Sunday instead" {
		t.Fatalf("request = %+v", got)
	}
	if messages := SteerReplyMessages(got); !strings.Contains(messages[0].Content, "answer") || !strings.Contains(messages[1].Content, "Which evening suits you?") {
		t.Fatalf("answer prompt = %+v", messages)
	}
	if replies := log.all(); len(replies) != 1 || replies[0].Status != SteerReplied {
		t.Fatalf("replies = %+v", replies)
	}
	if items := lease.SteerQueue.Drain(); len(items) != 0 {
		t.Fatalf("an answer was also queued as a steer: %#v", items)
	}
}

func TestSteerResponderBoundsConcurrency(t *testing.T) {
	control := New()
	for _, key := range []string{"chat:1", "chat:2", "chat:3"} {
		startSteerTestLease(t, control, ActiveRun{ConversationKey: key, TaskID: "task_" + key})
	}
	var running, peak atomic.Int32
	responder := NewSteerResponder(context.Background(), func(context.Context, SteerReplyRequest) (string, error) {
		now := running.Add(1)
		for {
			old := peak.Load()
			if now <= old || peak.CompareAndSwap(old, now) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
		running.Add(-1)
		return "Got it, adjusting.", nil
	}, SteerResponderOptions{Concurrency: 2})
	log := &steerReplyLog{}
	for _, key := range []string{"chat:1", "chat:2", "chat:3"} {
		for i := 0; i < 2; i++ {
			if err := responder.Respond(control.Steer("telegram", key, "more detail"), log.deliver); err != nil {
				t.Fatal(err)
			}
		}
	}
	responder.Wait()
	if len(log.all()) != 6 || peak.Load() > 2 {
		t.Fatalf("replies = %d, peak concurrency = %d; want 6 within 2", len(log.all()), peak.Load())
	}
}

func TestSteerQueueTicketsTellTheOutcome(t *testing.T) {
	queue := NewSteerQueue(0)
	applied, _, _ := queue.PushTicket("a")
	if applied.Outcome() != SteerPending {
		t.Fatal("new ticket is not pending")
	}
	queue.Drain()
	dropped, _, _ := queue.PushTicket("b")
	queue.Close()
	if applied.Outcome() != SteerApplied || dropped.Outcome() != SteerDropped {
		t.Fatalf("outcomes = %v, %v", applied.Outcome(), dropped.Outcome())
	}
	select {
	case <-dropped.Done():
	default:
		t.Fatal("dropped ticket is not done")
	}
	stopped := NewSteerQueue(0)
	ticket, _, _ := stopped.PushTicket("c")
	stopped.closeAs(SteerStopped)
	stopped.Close()
	if ticket.Outcome() != SteerStopped {
		t.Fatalf("outcome = %v, want stopped", ticket.Outcome())
	}
}

func TestMeaningfulSteerReply(t *testing.T) {
	cases := []struct {
		in   string
		want string
		err  bool
	}{
		{in: "  Sure, I'll use Celsius.  ", want: "Sure, I'll use Celsius."},
		{in: "```text\nI'll keep it short.\n```", want: "I'll keep it short."},
		{in: `{"type":"final","output":"Switching to the EU dataset."}`, want: "Switching to the EU dataset."},
		{in: "好的，我会改成简短回答。", want: "好的，我会改成简短回答。"},
		{in: "", err: true},
		{in: "👌", err: true},
		{in: "🙂🙂 …", err: true},
		{in: "```\n```", err: true},
		{in: `{"title":"Shared acceptance","icon":"book-open"}`, err: true},
	}
	for _, tc := range cases {
		got, err := MeaningfulSteerReply(tc.in)
		if tc.err {
			if !errors.Is(err, ErrSteerReplyNotMeaningful) {
				t.Errorf("MeaningfulSteerReply(%q) = %q, %v; want not meaningful", tc.in, got, err)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("MeaningfulSteerReply(%q) = %q, %v; want %q", tc.in, got, err, tc.want)
		}
	}
}

type llmClientFunc func(context.Context, llm.Request) (llm.Result, error)

func (f llmClientFunc) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	return f(ctx, req)
}
