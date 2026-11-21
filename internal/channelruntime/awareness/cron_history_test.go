package awareness

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

// jobLoop runs a cron loop over a stored job list. Its Run ends each job as the test says
// (fail), holding the jobs named in hold until the test releases them.
type jobLoop struct {
	t        *testing.T
	store    *cronstore.Store
	requests chan CronRequest
	now      time.Time
	// freshWait bounds the wait for a fresh input another worker holds (the default when 0).
	freshWait time.Duration

	mu   sync.Mutex
	fail map[string]error
	hold map[string]chan struct{}
	ran  []cronstore.DueTask
}

var jobLoopNow = time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

func startJobLoop(t *testing.T, tasks []cronstore.Task, configure func(*jobLoop)) *jobLoop {
	t.Helper()
	path := filepath.Join(t.TempDir(), "cron.yaml")
	l := &jobLoop{
		t:        t,
		store:    cronstore.NewStore(path),
		requests: make(chan CronRequest),
		now:      jobLoopNow,
		fail:     map[string]error{},
		hold:     map[string]chan struct{}{},
	}
	if err := l.store.Write(cronstore.File{Tasks: tasks}); err != nil {
		t.Fatalf("seed jobs: %v", err)
	}
	if configure != nil {
		configure(l)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		RunCronLoop(ctx, CronLoopOptions{
			Path:           path,
			Requests:       l.requests,
			MaxConcurrency: 4,
			FreshWait:      l.freshWait,
			Now: func() time.Time {
				l.mu.Lock()
				defer l.mu.Unlock()
				return l.now
			},
			Run: func(ctx context.Context, due cronstore.DueTask) error {
				id := due.Task.ID
				l.mu.Lock()
				l.ran = append(l.ran, due)
				gate, err := l.hold[id], l.fail[id]
				l.mu.Unlock()
				if gate != nil {
					select {
					case <-gate:
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				return err
			},
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("cron loop did not stop")
		}
		l.store.Close()
	})
	return l
}

// holdJob makes the job's runs wait until release is called.
func (l *jobLoop) holdJob(id string) (release func()) {
	gate := make(chan struct{})
	l.mu.Lock()
	l.hold[id] = gate
	l.mu.Unlock()
	var once sync.Once
	return func() { once.Do(func() { close(gate) }) }
}

// start asks the loop for a run of the stored job id, as the request says.
func (l *jobLoop) start(id string, cause cronstore.RunCause, input awarenessdomain.PokeInput) (string, error) {
	l.t.Helper()
	task, ok, err := l.store.FindByID(id)
	if err != nil || !ok {
		l.t.Fatalf("job %s: %v, %v", id, ok, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return StartCronRun(ctx, l.requests, cronstore.RunRequest{Task: task, Cause: cause, Input: input})
}

func (l *jobLoop) mustStart(id string) string {
	l.t.Helper()
	runID, err := l.start(id, cronstore.RunCause{}, awarenessdomain.PokeInput{})
	if err != nil || runID == "" {
		l.t.Fatalf("start %s = %q, %v", id, runID, err)
	}
	return runID
}

// history is the run history, oldest first.
func (l *jobLoop) history() []cronstore.RunRecord {
	l.t.Helper()
	runs, err := l.store.RunHistory(context.Background(), cronstore.RunHistoryQuery{Limit: cronstore.RunHistoryMaxLimit})
	if err != nil {
		l.t.Fatal(err)
	}
	slices.Reverse(runs)
	return runs
}

// waitSettled waits until the history has want runs and none of them is queued or running, then
// until it has stayed that way for a moment (so a run that should not start has had its chance).
func (l *jobLoop) waitSettled(want int) []cronstore.RunRecord {
	l.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	settled := func(runs []cronstore.RunRecord) bool {
		if len(runs) < want {
			return false
		}
		for _, run := range runs {
			if run.Status == cronstore.RunStatusQueued || run.Status == cronstore.RunStatusRunning {
				return false
			}
		}
		return true
	}
	for {
		runs := l.history()
		if settled(runs) {
			time.Sleep(60 * time.Millisecond)
			if again := l.history(); settled(again) && len(again) == len(runs) {
				if len(again) != want {
					l.t.Fatalf("history has %d runs, want %d:\n%s", len(again), want, describeRuns(again))
				}
				return again
			}
			continue
		}
		if time.Now().After(deadline) {
			l.t.Fatalf("history did not settle at %d runs:\n%s", want, describeRuns(runs))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// advance moves the loop's clock on.
func (l *jobLoop) advance(d time.Duration) {
	l.mu.Lock()
	l.now = l.now.Add(d)
	l.mu.Unlock()
}

func (l *jobLoop) ranIDs() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	ids := make([]string, 0, len(l.ran))
	for _, due := range l.ran {
		ids = append(ids, due.Task.ID)
	}
	return strings.Join(ids, ",")
}

// describeRuns writes runs one per line: "job status cause<-from note".
func describeRuns(runs []cronstore.RunRecord) string {
	lines := make([]string, 0, len(runs))
	for _, run := range runs {
		line := fmt.Sprintf("%s %s %s", run.JobID, run.Status, run.Cause.Kind)
		if run.Cause.FromJobID != "" {
			line += "<-" + run.Cause.FromJobID
		}
		if run.Cause.Note != "" {
			line += " (" + run.Cause.Note + ")"
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func runsOf(runs []cronstore.RunRecord, jobID string) []cronstore.RunRecord {
	var out []cronstore.RunRecord
	for _, run := range runs {
		if run.JobID == jobID {
			out = append(out, run)
		}
	}
	return out
}

func manualOnly(id string, uses ...cronstore.Use) cronstore.Task {
	return cronstore.Task{ID: id, Content: "Run " + id + ".", Triggers: []cronstore.Trigger{}, Uses: uses}
}

// Every run of a stored job is in the run history with what started it: the schedule trigger that
// fired, or a person. A run that starts a chain is its own origin.
func TestCronLoopRecordsEveryRunWithItsCause(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name       string
		task       cronstore.Task
		manual     bool
		fail       error
		wantKind   string
		wantTrig   string
		wantStatus string
		wantError  string
	}{
		{"a schedule fires", cronstore.Task{ID: "job", Content: "x", Triggers: []cronstore.Trigger{
			{ID: "other", Kind: cronstore.TriggerSchedule, Cron: "0 3 * * *", TZ: "UTC"},
			{ID: "noon", Kind: cronstore.TriggerSchedule, Cron: "0 12 * * *", TZ: "UTC"},
		}}, false, nil, cronstore.CauseSchedule, "noon", cronstore.RunStatusDone, ""},
		{"a legacy schedule fires", cronstore.Task{ID: "job", Content: "x", Cron: "0 12 * * *", TZ: "UTC"},
			false, nil, cronstore.CauseSchedule, cronstore.LegacyScheduleTriggerID, cronstore.RunStatusDone, ""},
		{"a schedule's run fails", cronstore.Task{ID: "job", Content: "x", Cron: "0 12 * * *", TZ: "UTC"},
			false, boom, cronstore.CauseSchedule, cronstore.LegacyScheduleTriggerID, cronstore.RunStatusFailed, "boom"},
		{"a person starts it", manualOnly("job"), true, nil, cronstore.CauseManual, "", cronstore.RunStatusDone, ""},
		{"a person's run fails", manualOnly("job"), true, boom, cronstore.CauseManual, "", cronstore.RunStatusFailed, "boom"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := startJobLoop(t, []cronstore.Task{tc.task}, func(l *jobLoop) { l.fail["job"] = tc.fail })
			wantRunID := ""
			if tc.manual {
				wantRunID = l.mustStart("job")
			}
			runs := l.waitSettled(1)
			run := runs[0]
			if run.JobID != "job" || run.Status != tc.wantStatus || run.Error != tc.wantError {
				t.Fatalf("run = %+v", run)
			}
			want := cronstore.RunCause{Kind: tc.wantKind, TriggerID: tc.wantTrig, OriginRunID: run.RunID}
			if run.Cause != want || run.RunID == "" || (wantRunID != "" && run.RunID != wantRunID) {
				t.Fatalf("cause = %+v, want %+v (run %s, asked %s)", run.Cause, want, run.RunID, wantRunID)
			}
			if run.QueuedAt != cronstore.RunTime(jobLoopNow) || run.StartedAt == "" || run.FinishedAt == "" {
				t.Fatalf("times = %+v", run)
			}
			// The board's record of how it ended carries the same cause.
			finished := cronstore.FinishedRuns(l.store.Path)
			if len(finished) != 1 || finished[0].RunID != run.RunID || finished[0].Cause != want {
				t.Fatalf("finished = %+v", finished)
			}
		})
	}
}

// While a run is held, the board and the history both show it, with its cause; stopping it
// before it starts ends it canceled.
func TestCronLoopShowsAQueuedRunAndRecordsItsStop(t *testing.T) {
	var release func()
	l := startJobLoop(t, []cronstore.Task{manualOnly("job")}, func(l *jobLoop) { release = l.holdJob("job") })
	defer release()
	runID := l.mustStart("job")
	deadline := time.Now().Add(5 * time.Second)
	for {
		runs := l.history()
		if len(runs) == 1 && runs[0].Status == cronstore.RunStatusRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("run did not start: %+v", runs)
		}
		time.Sleep(10 * time.Millisecond)
	}
	board := cronstore.Runs(l.store.Path)
	if len(board) != 1 || board[0].RunID != runID || board[0].Cause.Kind != cronstore.CauseManual || board[0].Cause.OriginRunID != runID || !board[0].Manual {
		t.Fatalf("board = %+v", board)
	}
	if got := cronstore.StopRun(l.store.Path, "job", runID); got.Status != cronstore.StopStopping {
		t.Fatalf("stop = %+v", got)
	}
	runs := l.waitSettled(1)
	if runs[0].Status != cronstore.RunStatusCanceled || runs[0].Error != cronstore.ErrRunStopped.Error() {
		t.Fatalf("stopped run = %+v", runs[0])
	}
}
