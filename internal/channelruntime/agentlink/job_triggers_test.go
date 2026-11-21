package agentlink

import (
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	link "github.com/quailyquaily/mistermorph/internal/agentlink"
	busruntime "github.com/quailyquaily/mistermorph/internal/bus"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/jobtriggers"
)

type jobTriggerRuns struct {
	mu   sync.Mutex
	runs []cronstore.RunRequest
}

func (r *jobTriggerRuns) run(_ context.Context, run cronstore.RunRequest) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.runs = append(r.runs, run)
	return "run_1", nil
}

func (r *jobTriggerRuns) snapshot() []cronstore.RunRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]cronstore.RunRequest(nil), r.runs...)
}

// A message an agent sends of its own accord starts the jobs that watch that agent, beside the
// task that answers it. Its answer to a message this agent sent starts none, and neither does a
// message from an agent no job watches.
func TestAgentLinkMessageStartsWatchingJobs(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sender, err := link.NewNode(link.Options{StateDir: t.TempDir(), AgentName: func() string { return "Asker" }})
	if err != nil {
		t.Fatal(err)
	}
	defer sender.Close()
	stranger, err := link.NewNode(link.Options{StateDir: t.TempDir(), AgentName: func() string { return "Stranger" }})
	if err != nil {
		t.Fatal(err)
	}
	defer stranger.Close()

	cronPath := filepath.Join(t.TempDir(), "cron.yaml")
	store := cronstore.NewStore(cronPath)
	t.Cleanup(store.Close)
	if err := store.Write(cronstore.File{Tasks: []cronstore.Task{
		{ID: "job-peer", Content: "File what the agent sent.", Triggers: []cronstore.Trigger{
			{ID: "trg-peer", Kind: cronstore.TriggerMessage, Channel: "agentlink", ChatID: link.ContactID(sender.InstanceID())}}},
	}}); err != nil {
		t.Fatal(err)
	}
	runs := &jobTriggerRuns{}
	dispatcher := jobtriggers.New(cronPath, runs.run, nil)
	dispatcher.MinInterval = time.Millisecond

	deps := testDeps(t)
	stop := Start(ctx, deps, Options{MaxHops: 3, JobTriggers: dispatcher})
	defer stop()
	runner, err := link.Shared(link.Options{StateDir: deps.RuntimePaths.StateDir})
	if err != nil {
		t.Fatal(err)
	}
	var got, strangerGot replies
	sender.SetHandler(got.handle)
	stranger.SetHandler(strangerGot.handle)
	relay := link.NewRelay(nil)
	connect(ctx, runner, relay, "runner")
	connect(ctx, sender, relay, "sender")
	connect(ctx, stranger, relay, "stranger")
	waitFor(t, "roster", func() bool { return sender.Reachable(runner.InstanceID()) && stranger.Reachable(runner.InstanceID()) })
	waitFor(t, "handler", runner.HasHandler)

	env := busruntime.MessageEnvelope{Text: "the nightly numbers are in", SessionID: "0194d8f0-0000-7000-8000-000000000011", SentAt: "2026-11-22T08:00:00Z"}
	res, err := sender.Send(ctx, runner.InstanceID(), env, 1, 5*time.Second)
	if err != nil || res.Status != link.StatusDelivered {
		t.Fatalf("Send() = %+v, %v", res, err)
	}
	waitFor(t, "the job's run", func() bool { return len(runs.snapshot()) == 1 })
	run := runs.snapshot()[0]
	if run.Task.ID != "job-peer" || run.Cause.Kind != cronstore.CauseMessage || run.Cause.TriggerID != "trg-peer" {
		t.Fatalf("run = %+v", run)
	}
	for _, want := range []string{`"channel": "agentlink"`, `"chat_id": "` + link.ContactID(sender.InstanceID()) + `"`, `"text": "the nightly numbers are in"`,
		`"sent_at": "2026-11-22T08:00:00Z"`, `"is_bot": true`} {
		if !strings.Contains(run.Input.BodyText, want) {
			t.Fatalf("input lacks %s:\n%s", want, run.Input.BodyText)
		}
	}
	// The conversation went on as it would without the job: the message was answered.
	waitFor(t, "the answer", func() bool { return len(got.snapshot()) == 1 })

	// An answer to a message this agent sent (ReplyTo set) starts no job.
	time.Sleep(5 * time.Millisecond)
	reply := busruntime.MessageEnvelope{Text: "thanks for the report", SessionID: "0194d8f0-0000-7000-8000-000000000012", ReplyTo: "msg_this_agent_sent"}
	if res, err := sender.Send(ctx, runner.InstanceID(), reply, 2, 5*time.Second); err != nil || res.Status != link.StatusDelivered {
		t.Fatalf("Send() = %+v, %v", res, err)
	}
	// An agent no job watches starts none.
	other := busruntime.MessageEnvelope{Text: "hello", SessionID: "0194d8f0-0000-7000-8000-000000000013"}
	if res, err := stranger.Send(ctx, runner.InstanceID(), other, 1, 5*time.Second); err != nil || res.Status != link.StatusDelivered {
		t.Fatalf("Send() = %+v, %v", res, err)
	}
	waitFor(t, "the stranger's answer", func() bool { return len(strangerGot.snapshot()) == 1 })
	time.Sleep(150 * time.Millisecond)
	if got := runs.snapshot(); len(got) != 1 {
		t.Fatalf("runs = %d, want 1: %+v", len(got), got)
	}
}
