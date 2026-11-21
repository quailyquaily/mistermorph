package awareness

import (
	"errors"
	"strings"
	"testing"
	"time"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

// A failed run that a one-time schedule started says in its note when the schedule is tried
// again; a failed run of any other kind has no such note.
func TestCronLoopNotesTheNextTryOfAOneTimeSchedule(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name     string
		task     cronstore.Task
		manual   bool
		wantNote string
	}{
		{"a one-time schedule", cronstore.Task{ID: "job", Content: "x", At: "2026-11-04 11:00", TZ: "UTC"}, false,
			"one-time schedule: try 1 of 5 failed; the next try is in 1m0s"},
		{"a recurring schedule", cronstore.Task{ID: "job", Content: "x", Cron: "0 12 * * *", TZ: "UTC"}, false, ""},
		{"a person's run of a one-time job", cronstore.Task{ID: "job", Content: "x", At: "2031-01-01 11:00", TZ: "UTC"}, true, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := startJobLoop(t, []cronstore.Task{tc.task}, func(l *jobLoop) { l.fail["job"] = boom })
			if tc.manual {
				l.mustStart("job")
			}
			run := l.waitSettled(1)[0]
			if run.Status != cronstore.RunStatusFailed || run.Error != "boom" || run.Cause.Note != tc.wantNote {
				t.Fatalf("run = %+v", run)
			}
			// The job is kept: only a run that ends done spends a one-time schedule.
			if _, ok, err := l.store.FindByID("job"); err != nil || !ok {
				t.Fatalf("job kept = %v, %v", ok, err)
			}
		})
	}
}

// The last try's note says that no other follows, and what to do.
func TestOnceRetryNoteOfTheLastTry(t *testing.T) {
	l := startJobLoop(t, []cronstore.Task{manualOnly("other")}, nil)
	task := cronstore.Task{ID: "job", Content: "x", At: "2026-11-04 11:00", TZ: "UTC", Triggers: []cronstore.Trigger{
		{ID: "once", Kind: cronstore.TriggerSchedule, At: "2026-11-04 11:00", TZ: "UTC"}}}
	scheduledAt := jobLoopNow.Add(-time.Hour)
	r := newCronLoopRunner(CronLoopOptions{Path: l.store.Path, Now: func() time.Time { return jobLoopNow }})
	item := cronstore.DueTask{Task: task, ScheduledAtUTC: scheduledAt, Cause: cronstore.RunCause{Kind: cronstore.CauseSchedule, TriggerID: "once"}}
	for try := 1; try <= len(cronstore.OnceRetryDelays)+1; try++ {
		note := r.onceRetryNote(item)
		last := try == len(cronstore.OnceRetryDelays)+1
		if last != strings.Contains(note, "it will not be tried again. Set a new time or run the job by hand.") || !strings.Contains(note, "try "+string(rune('0'+try))+" of 5 failed") {
			t.Fatalf("try %d: note = %q", try, note)
		}
		run, err := l.store.RecordRun(t.Context(), cronstore.RunRecord{JobID: "job", QueuedAt: cronstore.RunTime(jobLoopNow), Cause: item.Cause})
		if err != nil {
			t.Fatal(err)
		}
		if err := l.store.MarkRunFinished(t.Context(), run.RunID, cronstore.RunStatusFailed, "boom", note, jobLoopNow); err != nil {
			t.Fatal(err)
		}
	}
}
