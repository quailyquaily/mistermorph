package cron

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"
)

func historyIDs(runs []RunRecord) string {
	ids := make([]string, 0, len(runs))
	for _, run := range runs {
		ids = append(ids, run.RunID)
	}
	return strings.Join(ids, ",")
}

// A run is recorded when it is queued and updated as it starts and ends; a run that starts a
// chain is its own origin.
func TestRunHistoryRecordsARunFromQueueToEnd(t *testing.T) {
	base := time.Date(2030, 1, 1, 9, 0, 0, 0, time.UTC)
	cases := []struct {
		name       string
		cause      RunCause
		end        string
		errText    string
		note       string
		wantCause  RunCause
		wantError  string
		wantStatus string
	}{
		{"a schedule's run that ends done", RunCause{Kind: CauseSchedule, TriggerID: "trg-schedule"}, RunStatusDone, "", "",
			RunCause{Kind: CauseSchedule, TriggerID: "trg-schedule", OriginRunID: "run-1"}, "", RunStatusDone},
		{"a person's run that fails", RunCause{Kind: CauseManual}, RunStatusFailed, "boom\nwith a stack\nof lines", "",
			RunCause{Kind: CauseManual, OriginRunID: "run-1"}, "boom", RunStatusFailed},
		{"a chained run that is stopped", RunCause{Kind: CauseJob, FromJobID: "src", OriginRunID: "run-0"}, RunStatusCanceled, ErrRunStopped.Error(), "stopped before it started",
			RunCause{Kind: CauseJob, FromJobID: "src", OriginRunID: "run-0", Note: "stopped before it started"}, "stopped by user", RunStatusCanceled},
		{"a cause without a kind is a schedule's", RunCause{}, RunStatusDone, "", "",
			RunCause{Kind: CauseSchedule, OriginRunID: "run-1"}, "", RunStatusDone},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTriggerStore(t)
			ctx := context.Background()
			queued, err := store.RecordRun(ctx, RunRecord{RunID: "run-1", JobID: "a", QueuedAt: RunTime(base), Cause: tc.cause})
			if err != nil || queued.Status != RunStatusQueued {
				t.Fatalf("RecordRun = %+v, %v", queued, err)
			}
			runs, _ := store.RunHistory(ctx, RunHistoryQuery{})
			if len(runs) != 1 || runs[0].Status != RunStatusQueued || runs[0].StartedAt != "" || runs[0].FinishedAt != "" {
				t.Fatalf("queued = %+v", runs)
			}
			if err := store.MarkRunStarted(ctx, "run-1", base.Add(time.Minute)); err != nil {
				t.Fatal(err)
			}
			if runs, _ = store.RunHistory(ctx, RunHistoryQuery{}); runs[0].Status != RunStatusRunning || runs[0].StartedAt != "2030-01-01T09:01:00Z" {
				t.Fatalf("running = %+v", runs)
			}
			if err := store.MarkRunFinished(ctx, "run-1", tc.end, tc.errText, tc.note, base.Add(2*time.Minute)); err != nil {
				t.Fatal(err)
			}
			runs, _ = store.RunHistory(ctx, RunHistoryQuery{})
			want := RunRecord{RunID: "run-1", JobID: "a", Status: tc.wantStatus, QueuedAt: "2030-01-01T09:00:00Z",
				StartedAt: "2030-01-01T09:01:00Z", FinishedAt: "2030-01-01T09:02:00Z", Error: tc.wantError, Cause: tc.wantCause, ChainDepth: 1}
			if len(runs) != 1 || !reflect.DeepEqual(runs[0], want) {
				t.Fatalf("finished = %+v\nwant %+v", runs, want)
			}
		})
	}
}

func TestRunHistoryFilters(t *testing.T) {
	store := newTriggerStore(t)
	ctx := context.Background()
	base := time.Date(2030, 1, 1, 0, 0, 0, 0, time.UTC)
	// r1..r6, an hour apart, alternating between two jobs; r5 and r6 share a second.
	for i, job := range []string{"a", "b", "a", "b", "a", "b"} {
		at := base.Add(time.Duration(i) * time.Hour)
		if i == 5 {
			at = base.Add(4 * time.Hour)
		}
		if _, err := store.RecordRun(ctx, RunRecord{RunID: fmt.Sprintf("r%d", i+1), JobID: job, QueuedAt: RunTime(at)}); err != nil {
			t.Fatal(err)
		}
	}
	cases := []struct {
		name  string
		query RunHistoryQuery
		want  string
	}{
		{"everything, newest first", RunHistoryQuery{}, "r6,r5,r4,r3,r2,r1"},
		{"one job", RunHistoryQuery{JobID: "a"}, "r5,r3,r1"},
		{"an unknown job", RunHistoryQuery{JobID: "ghost"}, ""},
		{"from is inclusive", RunHistoryQuery{From: base.Add(3 * time.Hour)}, "r6,r5,r4"},
		{"to is exclusive", RunHistoryQuery{To: base.Add(3 * time.Hour)}, "r3,r2,r1"},
		{"a window", RunHistoryQuery{From: base.Add(time.Hour), To: base.Add(4 * time.Hour)}, "r4,r3,r2"},
		{"a window in another zone", RunHistoryQuery{From: base.Add(time.Hour).In(time.FixedZone("x", 8*3600)), To: base.Add(4 * time.Hour)}, "r4,r3,r2"},
		{"a window and a job", RunHistoryQuery{JobID: "b", From: base.Add(time.Hour), To: base.Add(4 * time.Hour)}, "r4,r2"},
		{"a limit keeps the newest", RunHistoryQuery{Limit: 2}, "r6,r5"},
		{"a limit and a job", RunHistoryQuery{JobID: "b", Limit: 2}, "r6,r4"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			runs, err := store.RunHistory(ctx, tc.query)
			if err != nil || historyIDs(runs) != tc.want || runs == nil {
				t.Fatalf("runs = %s (%v), want %s", historyIDs(runs), err, tc.want)
			}
		})
	}
	t.Run("the limit is bounded", func(t *testing.T) {
		for i := 0; i < RunHistoryDefaultLimit+10; i++ {
			if _, err := store.RecordRun(ctx, RunRecord{JobID: "bulk", QueuedAt: RunTime(base)}); err != nil {
				t.Fatal(err)
			}
		}
		if runs, _ := store.RunHistory(ctx, RunHistoryQuery{JobID: "bulk"}); len(runs) != RunHistoryDefaultLimit {
			t.Fatalf("default limit gave %d runs", len(runs))
		}
		if runs, _ := store.RunHistory(ctx, RunHistoryQuery{JobID: "bulk", Limit: RunHistoryMaxLimit * 10}); len(runs) != RunHistoryDefaultLimit+10 {
			t.Fatalf("a large limit gave %d runs", len(runs))
		}
	})
}

// The history keeps the newest runs of each job and nothing older than its age limit.
func TestRunHistoryRetention(t *testing.T) {
	store := newTriggerStore(t)
	ctx := context.Background()
	base := time.Date(2030, 6, 1, 0, 0, 0, 0, time.UTC)
	for i := 0; i < RunHistoryKeptPerJob+25; i++ {
		if _, err := store.RecordRun(ctx, RunRecord{RunID: fmt.Sprintf("busy-%03d", i), JobID: "busy", QueuedAt: RunTime(base.Add(time.Duration(i) * time.Minute))}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.RecordRun(ctx, RunRecord{RunID: "quiet-1", JobID: "quiet", QueuedAt: RunTime(base)}); err != nil {
		t.Fatal(err)
	}
	busy, _ := store.RunHistory(ctx, RunHistoryQuery{JobID: "busy", Limit: RunHistoryMaxLimit})
	if len(busy) != RunHistoryKeptPerJob || busy[0].RunID != fmt.Sprintf("busy-%03d", RunHistoryKeptPerJob+24) || busy[len(busy)-1].RunID != "busy-025" {
		t.Fatalf("busy keeps %d runs, %s .. %s", len(busy), busy[0].RunID, busy[len(busy)-1].RunID)
	}
	// Another job's runs are not counted against it.
	if quiet, _ := store.RunHistory(ctx, RunHistoryQuery{JobID: "quiet"}); historyIDs(quiet) != "quiet-1" {
		t.Fatalf("quiet = %s", historyIDs(quiet))
	}

	// A run recorded long after: what is older than the age limit goes, whatever its job.
	later := base.Add(RunHistoryMaxAge + 2*time.Hour)
	if _, err := store.RecordRun(ctx, RunRecord{RunID: "late", JobID: "other", QueuedAt: RunTime(later)}); err != nil {
		t.Fatal(err)
	}
	all, _ := store.RunHistory(ctx, RunHistoryQuery{Limit: RunHistoryMaxLimit})
	cutoff := RunTime(later.Add(-RunHistoryMaxAge))
	for _, run := range all {
		if run.QueuedAt < cutoff {
			t.Fatalf("run %s of %s outlived the age limit", run.RunID, run.QueuedAt)
		}
	}
	// busy's runs after 02:00 are within the limit and stay; quiet's one run is gone.
	if len(all) == 1 || all[0].RunID != "late" {
		t.Fatalf("after the age limit: %d runs, newest %s", len(all), all[0].RunID)
	}
	if quiet, _ := store.RunHistory(ctx, RunHistoryQuery{JobID: "quiet"}); len(quiet) != 0 {
		t.Fatalf("quiet = %s", historyIDs(quiet))
	}
}

// Runs a runtime left queued or running when it stopped are ended as failed; newer ones, and
// ones that ended, are left alone.
func TestFailStaleRuns(t *testing.T) {
	store := newTriggerStore(t)
	ctx := context.Background()
	now := time.Date(2030, 1, 10, 0, 0, 0, 0, time.UTC)
	seed := []RunRecord{
		{RunID: "old-queued", JobID: "a", Status: RunStatusQueued, QueuedAt: RunTime(now.Add(-48 * time.Hour))},
		{RunID: "old-running", JobID: "a", Status: RunStatusRunning, QueuedAt: RunTime(now.Add(-30 * time.Hour))},
		{RunID: "old-done", JobID: "a", Status: RunStatusDone, QueuedAt: RunTime(now.Add(-30 * time.Hour))},
		{RunID: "new-running", JobID: "a", Status: RunStatusRunning, QueuedAt: RunTime(now.Add(-time.Hour))},
	}
	for _, run := range seed {
		if _, err := store.RecordRun(ctx, run); err != nil {
			t.Fatal(err)
		}
	}
	n, err := store.FailStaleRuns(ctx, now.Add(-StaleRunAfter))
	if err != nil || n != 2 {
		t.Fatalf("FailStaleRuns = %d, %v", n, err)
	}
	runs, _ := store.RunHistory(ctx, RunHistoryQuery{})
	got := map[string]string{}
	for _, run := range runs {
		got[run.RunID] = run.Status
		if strings.HasPrefix(run.RunID, "old-") && run.Status == RunStatusFailed && (run.Error == "" || run.FinishedAt == "") {
			t.Fatalf("stale run = %+v", run)
		}
	}
	want := map[string]string{"old-queued": RunStatusFailed, "old-running": RunStatusFailed, "old-done": RunStatusDone, "new-running": RunStatusRunning}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("statuses = %v, want %v", got, want)
	}
}

// The live board shows each run's cause, while it is held and once it has ended.
func TestRunBoardShowsTheCause(t *testing.T) {
	at := time.Date(2030, 1, 1, 9, 0, 0, 0, time.UTC)
	cases := []struct {
		name       string
		queue      func(b *RunBoard) string
		wantKind   string
		wantManual bool
		wantFrom   string
	}{
		{"Queue for a schedule", func(b *RunBoard) string { return b.Queue("a", false, at) }, CauseSchedule, false, ""},
		{"Queue for a person", func(b *RunBoard) string { return b.Queue("a", true, at) }, CauseManual, true, ""},
		{"QueueRun for a poke", func(b *RunBoard) string {
			id, _ := b.QueueRun("a", RunCause{Kind: CausePoke, TriggerID: "p"}, at)
			return id
		}, CausePoke, false, ""},
		{"QueueRun in a chain", func(b *RunBoard) string {
			id, _ := b.QueueRun("a", RunCause{Kind: CauseJob, FromJobID: "src", OriginRunID: "run-0"}, at)
			return id
		}, CauseJob, false, "src"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			board := &RunBoard{}
			runID := tc.queue(board)
			runs := board.list()
			if len(runs) != 1 || runs[0].Cause.Kind != tc.wantKind || runs[0].Manual != tc.wantManual || runs[0].Cause.FromJobID != tc.wantFrom {
				t.Fatalf("runs = %+v", runs)
			}
			wantOrigin := runID
			if tc.wantFrom != "" {
				wantOrigin = "run-0"
			}
			if runs[0].Cause.OriginRunID != wantOrigin {
				t.Fatalf("origin = %q, want %q", runs[0].Cause.OriginRunID, wantOrigin)
			}
			board.Start("a", runID, at, func(error) {})
			board.Finish("a", runID, RunStatusDone, at)
			finished := board.listFinished()
			if len(finished) != 1 || finished[0].Cause != runs[0].Cause {
				t.Fatalf("finished = %+v", finished)
			}
		})
	}
}
