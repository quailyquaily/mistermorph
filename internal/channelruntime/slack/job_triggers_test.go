package slack

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/jobtriggers"
)

type jobTriggerRuns struct {
	mu   sync.Mutex
	runs []cronstore.RunRequest
	busy bool
}

func (r *jobTriggerRuns) run(_ context.Context, run cronstore.RunRequest) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.busy {
		return "", daemonruntime.ErrCronBusy
	}
	r.runs = append(r.runs, run)
	return "run_1", nil
}

func (r *jobTriggerRuns) snapshot() []cronstore.RunRequest {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]cronstore.RunRequest(nil), r.runs...)
}

func waitForJobTrigger(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// A message in a channel a job watches starts the job, whether or not the agent would answer it
// (here the channel is not one the agent may talk in); the agent's own posts, a job's
// notification among them, and other channels start nothing.
func TestSlackInboundMessageStartsWatchingJobs(t *testing.T) {
	cases := []struct {
		name  string
		event map[string]any
		busy  bool
		want  bool
	}{
		{"a channel message not addressed to the agent", map[string]any{"type": "message", "user": "U11", "text": "deploy is red", "channel": "C1", "channel_type": "channel", "ts": "10.1"}, false, true},
		{"another bot's message", map[string]any{"type": "message", "subtype": "bot_message", "bot_id": "B777", "text": "build failed", "channel": "C1", "channel_type": "channel", "ts": "10.2"}, false, true},
		{"the agent's own post, by bot id", map[string]any{"type": "message", "subtype": "bot_message", "bot_id": "B100", "text": "the job's report", "channel": "C1", "channel_type": "channel", "ts": "10.3"}, false, false},
		{"the agent's own post, by user id", map[string]any{"type": "message", "user": "U100", "text": "the job's report", "channel": "C1", "channel_type": "channel", "ts": "10.4"}, false, false},
		{"a channel no job watches", map[string]any{"type": "message", "user": "U11", "text": "hello", "channel": "C2", "channel_type": "channel", "ts": "10.5"}, false, false},
		{"a job that is already running", map[string]any{"type": "message", "user": "U11", "text": "again", "channel": "C1", "channel_type": "channel", "ts": "10.6"}, true, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cronPath := filepath.Join(t.TempDir(), "cron.yaml")
			store := cronstore.NewStore(cronPath)
			t.Cleanup(store.Close)
			if err := store.Write(cronstore.File{Tasks: []cronstore.Task{
				{ID: "job-alerts", Content: "Triage.", Triggers: []cronstore.Trigger{{ID: "trg-alerts", Kind: cronstore.TriggerMessage, Channel: "slack", ChatID: "slack:T1:C1"}}},
			}}); err != nil {
				t.Fatal(err)
			}
			runs := &jobTriggerRuns{busy: tc.busy}
			state := &slackRuntimeState{
				logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
				botUserID:       "U100",
				botID:           "B100",
				allowedTeams:    map[string]bool{"T999": true},
				allowedChannels: map[string]bool{"C999": true},
				options:         RunOptions{JobTriggers: jobtriggers.New(cronPath, runs.run, nil)},
			}
			payload, err := json.Marshal(map[string]any{"team_id": "T1", "event_id": "Ev1", "event_time": 1786932000, "event": tc.event})
			if err != nil {
				t.Fatal(err)
			}
			if err := state.handleSocketEnvelope(context.Background(), slackSocketEnvelope{Type: "events_api", Payload: payload}); err != nil {
				t.Fatalf("handleSocketEnvelope() error = %v", err)
			}
			switch {
			case tc.busy:
				waitForJobTrigger(t, "the skipped run", func() bool {
					history, err := store.RunHistory(context.Background(), cronstore.RunHistoryQuery{JobID: "job-alerts"})
					return err == nil && len(history) == 1 && history[0].Status == cronstore.RunStatusSkipped &&
						history[0].Cause.Kind == cronstore.CauseMessage && strings.Contains(history[0].Cause.Note, "already queued or running")
				})
			case !tc.want:
				time.Sleep(100 * time.Millisecond)
				if got := runs.snapshot(); len(got) != 0 {
					t.Fatalf("started %+v", got)
				}
			default:
				waitForJobTrigger(t, "the run", func() bool { return len(runs.snapshot()) == 1 })
				run := runs.snapshot()[0]
				if run.Task.ID != "job-alerts" || run.Cause.Kind != cronstore.CauseMessage || run.Cause.TriggerID != "trg-alerts" {
					t.Fatalf("run = %+v", run)
				}
				text, _ := tc.event["text"].(string)
				if !strings.Contains(run.Input.BodyText, `"text": "`+text+`"`) || !strings.Contains(run.Input.BodyText, `"chat_id": "slack:T1:C1"`) {
					t.Fatalf("input:\n%s", run.Input.BodyText)
				}
				// The same message again (a mention arrives as a second event) starts nothing more.
				if err := state.handleSocketEnvelope(context.Background(), slackSocketEnvelope{Type: "events_api", Payload: payload}); err != nil {
					t.Fatal(err)
				}
				time.Sleep(100 * time.Millisecond)
				if got := runs.snapshot(); len(got) != 1 {
					t.Fatalf("the same message started the job %d times", len(got))
				}
			}
		})
	}
}
