package awareness

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/jobtriggers"
)

// A message that fires a job's message trigger queues one run through the cron loop, with the
// message as its cause and its data; while that run goes on, a later message leaves a skipped
// run; and a run that ends done starts the jobs that use it, as any run does.
func TestCronLoopRunsAJobAMessageStarted(t *testing.T) {
	var release func()
	l := startJobLoop(t, []cronstore.Task{
		{ID: "watcher", Content: "Triage the message.", Triggers: []cronstore.Trigger{
			{ID: "chat", Kind: cronstore.TriggerMessage, Channel: "telegram", ChatID: "tg:-100"},
		}},
		manualOnly("after", each("watcher")...),
	}, func(l *jobLoop) { release = l.holdJob("watcher") })
	defer release()
	now := time.Date(2026, 11, 22, 9, 0, 0, 0, time.UTC)
	dispatcher := jobtriggers.New(l.store.Path, func(ctx context.Context, run cronstore.RunRequest) (string, error) {
		return StartCronRun(ctx, l.requests, run)
	}, nil)
	dispatcher.Now = func() time.Time { return now }

	message := jobtriggers.Message{Channel: "telegram", ChatIDs: []string{"tg:-100"}, MessageID: "1", SenderName: "Ada", Text: "the build is red"}
	results := dispatcher.Handle(context.Background(), message)
	if len(results) != 1 || results[0].Outcome != jobtriggers.Started || results[0].RunID == "" {
		t.Fatalf("results = %+v", results)
	}
	runID := results[0].RunID
	waitFor(t, "the run to start", func() bool {
		runs := runsOf(l.history(), "watcher")
		return len(runs) == 1 && runs[0].Status == cronstore.RunStatusRunning
	})

	// Still running a minute later: the next message is recorded as skipped.
	now = now.Add(2 * jobtriggers.DefaultMinInterval)
	message.MessageID = "2"
	if results := dispatcher.Handle(context.Background(), message); len(results) != 1 || results[0].Outcome != jobtriggers.Busy {
		t.Fatalf("results = %+v", results)
	}
	release()
	runs := l.waitSettled(3)
	if got, want := chainLines(runs), []string{"after done job<-watcher", "watcher done message", "watcher skipped message"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("history:\n%s", describeRuns(runs))
	}
	for _, run := range runsOf(runs, "watcher") {
		if run.Cause.TriggerID != "chat" {
			t.Fatalf("run = %+v", run)
		}
		if run.Status == cronstore.RunStatusSkipped && !strings.Contains(run.Cause.Note, "already queued or running") {
			t.Fatalf("skipped run = %+v", run)
		}
		if run.Status == cronstore.RunStatusDone && (run.RunID != runID || run.Cause.OriginRunID != runID) {
			t.Fatalf("run = %+v", run)
		}
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	ran := l.ran[0]
	if ran.Task.ID != "watcher" || ran.Manual || ran.Cause.Kind != cronstore.CauseMessage || !strings.Contains(ran.Input.BodyText, `"text": "the build is red"`) ||
		!strings.Contains(ran.Input.BodyText, `"name": "Ada"`) {
		t.Fatalf("ran = %+v", ran)
	}
}
