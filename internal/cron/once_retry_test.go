package cron

import (
	"context"
	"path/filepath"
	"testing"
	"time"
)

// A one-time job whose runs keep failing is tried again after 1, 5, 15 and 60 minutes, and then
// no more. Each line is one moment: whether the schedule is due, and whether the run it then
// starts fails.
func TestOnceScheduleBacksOffAfterFailures(t *testing.T) {
	at := time.Date(2030, 1, 2, 9, 0, 0, 0, time.UTC)
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	t.Cleanup(store.Close)
	if err := store.Write(File{Tasks: []Task{{ID: "once", At: "2030-01-02 09:00", TZ: "UTC", Content: "Send it."}}}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	// fail records a run the schedule started at now, which failed.
	fail := func(now time.Time, status, note string) {
		t.Helper()
		run, err := store.RecordRun(ctx, RunRecord{JobID: "once", QueuedAt: RunTime(now), Cause: RunCause{Kind: CauseSchedule, TriggerID: LegacyScheduleTriggerID}})
		if err != nil {
			t.Fatal(err)
		}
		if err := store.RecordRunStart("once", now); err != nil {
			t.Fatal(err)
		}
		if err := store.MarkRunFinished(ctx, run.RunID, status, "boom", note, now); err != nil {
			t.Fatal(err)
		}
		if err := store.RecordRunResult("once", RunStatusFailed); err != nil {
			t.Fatal(err)
		}
	}
	steps := []struct {
		name    string
		after   time.Duration // since the schedule's time
		wantDue bool
	}{
		{"before its time", -time.Minute, false},
		{"at its time: try 1", 0, true},
		{"30 seconds after the failure", 30 * time.Second, false},
		{"1 minute after: try 2", time.Minute, true},
		{"4 minutes after try 2", 5 * time.Minute, false},
		{"5 minutes after try 2: try 3", 6 * time.Minute, true},
		{"14 minutes after try 3", 20 * time.Minute, false},
		{"15 minutes after try 3: try 4", 21 * time.Minute, true},
		{"59 minutes after try 4", 80 * time.Minute, false},
		{"60 minutes after try 4: try 5", 81 * time.Minute, true},
		{"a minute after try 5: given up", 82 * time.Minute, false},
		{"a day later: still given up", 24 * time.Hour, false},
	}
	tries := 0
	for _, step := range steps {
		now := at.Add(step.after)
		if got := dueIDs(t, store, now)["once"]; got != step.wantDue {
			t.Fatalf("%s: due = %v, want %v", step.name, got, step.wantDue)
		}
		if step.wantDue {
			tries++
			fail(now, RunStatusFailed, "")
			retry, err := store.OnceRetryState(ctx, "once", LegacyScheduleTriggerID, at)
			if err != nil || retry.Failures != tries || !retry.LastFailedAt.Equal(now) || retry.GaveUp() != (tries == 5) {
				t.Fatalf("%s: retry = %+v, %v", step.name, retry, err)
			}
			if tries < 5 && !retry.NextAt().Equal(now.Add(OnceRetryDelays[tries-1])) {
				t.Fatalf("%s: next try at %s", step.name, retry.NextAt())
			}
		}
	}
	if tries != len(OnceRetryDelays)+1 {
		t.Fatalf("tries = %d", tries)
	}
	// The job is still there, with its last run failed and the last error in the history.
	task, ok, err := store.FindByID("once")
	if err != nil || !ok || task.LastRunStatus != RunStatusFailed || task.At != "2030-01-02 09:00" {
		t.Fatalf("task = %+v, %v, %v", task, ok, err)
	}
	if last, ok, err := store.LatestRun(ctx, "once"); err != nil || !ok || last.Status != RunStatusFailed || last.Error != "boom" {
		t.Fatalf("last run = %+v, %v, %v", last, ok, err)
	}

	// A new time starts afresh: the earlier failures were of the earlier time.
	newAt := "2030-01-04 09:00"
	if _, err := store.Update(ctx, "once", TaskPatch{At: &newAt}); err != nil {
		t.Fatal(err)
	}
	later := time.Date(2030, 1, 4, 9, 0, 0, 0, time.UTC)
	if dueIDs(t, store, later.Add(-time.Minute))["once"] || !dueIDs(t, store, later)["once"] {
		t.Fatal("a new time did not start afresh")
	}
}

// What counts as a failed try: a run the schedule started that failed or was skipped for an
// input. A run someone else started, a run of another trigger and a run dropped for a full queue
// do not; a skipped one does.
func TestOnceRetryStateCountsOnlyTheSchedulesOwnFailures(t *testing.T) {
	at := time.Date(2030, 1, 2, 9, 0, 0, 0, time.UTC)
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	t.Cleanup(store.Close)
	ctx := context.Background()
	cases := []struct {
		name   string
		run    RunRecord
		status string
		note   string
		counts bool
	}{
		{"the schedule's run failed", RunRecord{Cause: RunCause{Kind: CauseSchedule, TriggerID: "once"}}, RunStatusFailed, "", true},
		{"the schedule's run was skipped for an input", RunRecord{Cause: RunCause{Kind: CauseSchedule, TriggerID: "once"}}, RunStatusSkipped, "input job in failed", true},
		{"dropped for a full queue", RunRecord{Cause: RunCause{Kind: CauseSchedule, TriggerID: "once"}}, RunStatusSkipped, QueueFullNote, false},
		{"a person's run failed", RunRecord{Cause: RunCause{Kind: CauseManual}}, RunStatusFailed, "", false},
		{"a poke's run failed", RunRecord{Cause: RunCause{Kind: CausePoke, TriggerID: "hook"}}, RunStatusFailed, "", false},
		{"another schedule's run failed", RunRecord{Cause: RunCause{Kind: CauseSchedule, TriggerID: "daily"}}, RunStatusFailed, "", false},
		{"the schedule's run ended done", RunRecord{Cause: RunCause{Kind: CauseSchedule, TriggerID: "once"}}, RunStatusDone, "", false},
		{"a failure before the schedule's time", RunRecord{QueuedAt: RunTime(at.Add(-time.Hour)), Cause: RunCause{Kind: CauseSchedule, TriggerID: "once"}}, RunStatusFailed, "", false},
	}
	for i, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			jobID := "job-" + string(rune('a'+i))
			run := tc.run
			run.JobID = jobID
			if run.QueuedAt == "" {
				run.QueuedAt = RunTime(at.Add(time.Minute))
			}
			recorded, err := store.RecordRun(ctx, run)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.MarkRunFinished(ctx, recorded.RunID, tc.status, "", tc.note, at.Add(2*time.Minute)); err != nil {
				t.Fatal(err)
			}
			retry, err := store.OnceRetryState(ctx, jobID, "once", at)
			if err != nil || (retry.Failures == 1) != tc.counts {
				t.Fatalf("retry = %+v, %v", retry, err)
			}
		})
	}
}
