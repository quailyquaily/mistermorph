package awareness

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

func fresh(id string, maxAge ...string) cronstore.Use {
	use := cronstore.Use{JobID: id, Mode: cronstore.UseFresh}
	if len(maxAge) > 0 {
		use.MaxAge = maxAge[0]
	}
	return use
}

func countRan(l *jobLoop, id string) int {
	count := 0
	for _, ran := range strings.Split(l.ranIDs(), ",") {
		if ran == id {
			count++
		}
	}
	return count
}

// A job with a fresh input runs the input first when its latest done run is older than the max
// age, or when it never ran; otherwise it starts with what is there.
func TestCronLoopRefreshesAFreshInputByAge(t *testing.T) {
	cases := []struct {
		name string
		use  cronstore.Use
		// ranBefore: the input ran once, age ago.
		ranBefore   bool
		age         time.Duration
		wantRefresh bool
	}{
		{"never ran", fresh("in"), false, 0, true},
		{"just ran", fresh("in"), true, time.Minute, false},
		{"at the default max age", fresh("in"), true, time.Hour, false},
		{"older than the default max age", fresh("in"), true, time.Hour + time.Second, true},
		{"within its own max age", fresh("in", "3h"), true, 2 * time.Hour, false},
		{"older than its own max age", fresh("in", "5m"), true, 6 * time.Minute, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := startJobLoop(t, []cronstore.Task{manualOnly("in"), manualOnly("out", tc.use)}, nil)
			want := []string{"out done manual"}
			if tc.ranBefore {
				l.mustStart("in")
				l.waitSettled(1)
				l.advance(tc.age)
				want = append(want, "in done manual")
			}
			origin := l.mustStart("out")
			if tc.wantRefresh {
				want = append(want, "in done job<-out")
			}
			runs := l.waitSettled(len(want))
			got := chainLines(runs)
			wantSorted := append([]string(nil), want...)
			sort.Strings(wantSorted)
			if !reflect.DeepEqual(got, wantSorted) {
				t.Fatalf("history:\n%s", describeRuns(runs))
			}
			if !tc.wantRefresh {
				return
			}
			// The input ran before the job, in the job's chain, and says what it was run for.
			ran := strings.Split(l.ranIDs(), ",")
			if n := len(ran); ran[n-2] != "in" || ran[n-1] != "out" {
				t.Fatalf("ran = %v", ran)
			}
			for _, run := range runs {
				if run.JobID == "in" && run.Cause.Kind == cronstore.CauseJob {
					if run.Cause.OriginRunID != origin || !strings.Contains(run.Cause.Note, "fresh result") || !strings.Contains(run.Cause.Note, "out") {
						t.Fatalf("input run = %+v", run)
					}
				}
			}
		})
	}
}

// When the input cannot give a fresh result, the job is recorded as skipped, with a note that
// names the input, and nothing below it runs.
func TestCronLoopSkipsWhenAFreshInputCannotBeMade(t *testing.T) {
	boom := errors.New("boom")
	off := false
	cases := []struct {
		name     string
		tasks    []cronstore.Task
		fail     map[string]error
		start    string
		want     []string
		wantRan  string
		wantNote map[string]string
	}{
		{
			name:     "the input fails",
			tasks:    []cronstore.Task{manualOnly("in"), manualOnly("out", fresh("in")), manualOnly("below", each("out")...)},
			fail:     map[string]error{"in": boom},
			start:    "out",
			want:     []string{"below skipped job<-out", "in failed job<-out", "out skipped manual"},
			wantRan:  "in",
			wantNote: map[string]string{"out": "input job in failed", "below": "input job out was skipped"},
		},
		{
			name: "the input is switched off",
			tasks: []cronstore.Task{{ID: "in", Content: "Run in.", Enabled: &off, Triggers: []cronstore.Trigger{}},
				manualOnly("out", fresh("in")), manualOnly("below", each("out")...)},
			start:    "out",
			want:     []string{"below skipped job<-out", "out skipped manual"},
			wantRan:  "",
			wantNote: map[string]string{"out": "input job in is switched off"},
		},
		{
			name:     "the input's own fresh input fails",
			tasks:    []cronstore.Task{manualOnly("deep"), manualOnly("in", fresh("deep")), manualOnly("out", fresh("in"))},
			fail:     map[string]error{"deep": boom},
			start:    "out",
			want:     []string{"deep failed job<-in", "in skipped job<-out", "out skipped manual"},
			wantRan:  "deep",
			wantNote: map[string]string{"in": "input job deep failed", "out": "input job in was skipped"},
		},
		{
			name: "the chain would be too deep",
			tasks: []cronstore.Task{manualOnly("in"), manualOnly("j1"), manualOnly("j2", each("j1")...), manualOnly("j3", each("j2")...),
				manualOnly("j4", each("j3")...), manualOnly("j5", cronstore.Use{JobID: "j4", Mode: cronstore.UseEach}, fresh("in"))},
			start:    "j1",
			want:     []string{"j1 done manual", "j2 done job<-j1", "j3 done job<-j2", "j4 done job<-j3", "j5 skipped job<-j4"},
			wantRan:  "j1,j2,j3,j4",
			wantNote: map[string]string{"j5": fmt.Sprintf("more than %d jobs deep", cronstore.MaxChainDepth)},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := startJobLoop(t, tc.tasks, func(l *jobLoop) {
				for id, err := range tc.fail {
					l.fail[id] = err
				}
			})
			origin := l.mustStart(tc.start)
			runs := l.waitSettled(len(tc.want))
			if got := chainLines(runs); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("history:\n%s", describeRuns(runs))
			}
			if l.ranIDs() != tc.wantRan {
				t.Fatalf("ran = %q, want %q", l.ranIDs(), tc.wantRan)
			}
			for _, run := range runs {
				if run.Cause.OriginRunID != origin {
					t.Fatalf("run of %s has origin %q, want %q", run.JobID, run.Cause.OriginRunID, origin)
				}
				if note, ok := tc.wantNote[run.JobID]; ok && !strings.Contains(run.Cause.Note, note) {
					t.Fatalf("note of %s = %q, want %q", run.JobID, run.Cause.Note, note)
				}
				if run.Status == cronstore.RunStatusSkipped && (run.StartedAt != "" || run.FinishedAt == "") {
					t.Fatalf("skipped run = %+v", run)
				}
			}
			// A skipped job never started: its last run stays unset, and it is free to run again.
			if tc.start == "out" {
				stored, _, err := l.store.FindByID("out")
				if err != nil || stored.LastRunAt != "" || len(cronstore.Runs(l.store.Path)) != 0 {
					t.Fatalf("out = %+v, board = %+v (%v)", stored, cronstore.Runs(l.store.Path), err)
				}
			}
		})
	}
}

// Two jobs of one chain that need the same fresh input get one run of it between them, whether
// that run ends done or not.
func TestCronLoopRefreshesAnInputOncePerChain(t *testing.T) {
	boom := errors.New("boom")
	for _, tc := range []struct {
		name string
		fail bool
		want []string
	}{
		{"done", false, []string{"b done job<-root", "c done job<-root", "in done job<-*", "root done manual"}},
		{"failed", true, []string{"b skipped job<-root", "c skipped job<-root", "in failed job<-*", "root done manual"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tasks := []cronstore.Task{manualOnly("in"), manualOnly("root"),
				manualOnly("b", cronstore.Use{JobID: "root", Mode: cronstore.UseEach}, fresh("in")),
				manualOnly("c", cronstore.Use{JobID: "root", Mode: cronstore.UseEach}, fresh("in"))}
			l := startJobLoop(t, tasks, func(l *jobLoop) {
				if tc.fail {
					l.fail["in"] = boom
				}
			})
			l.mustStart("root")
			runs := l.waitSettled(len(tc.want))
			got := chainLines(runs)
			for i, line := range got {
				if strings.HasPrefix(line, "in ") {
					got[i] = line[:strings.Index(line, "<-")] + "<-*"
				}
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("history:\n%s", describeRuns(runs))
			}
			if n := countRan(l, "in"); n != 1 {
				t.Fatalf("the input ran %d times, want 1 (ran %s)", n, l.ranIDs())
			}
			for _, run := range runs {
				if run.Status == cronstore.RunStatusSkipped && !strings.Contains(run.Cause.Note, "input job in failed") {
					t.Fatalf("skipped run = %+v", run)
				}
			}
		})
	}
}

// An input that is already running is waited for, not started a second time.
func TestCronLoopWaitsForAFreshInputThatIsRunning(t *testing.T) {
	var release func()
	l := startJobLoop(t, []cronstore.Task{manualOnly("in"), manualOnly("out", fresh("in"))},
		func(l *jobLoop) { release = l.holdJob("in") })
	defer release()
	l.mustStart("in")
	waitFor(t, "the input to start", func() bool {
		in := runsOf(l.history(), "in")
		return len(in) == 1 && in[0].Status == cronstore.RunStatusRunning
	})
	l.mustStart("out")
	// The job stays queued while its input runs.
	time.Sleep(150 * time.Millisecond)
	if out := runsOf(l.history(), "out"); len(out) != 1 || out[0].Status != cronstore.RunStatusQueued || l.ranIDs() != "in" {
		t.Fatalf("while waiting:\n%s (ran %s)", describeRuns(l.history()), l.ranIDs())
	}
	release()
	runs := l.waitSettled(2)
	if got, want := chainLines(runs), []string{"in done manual", "out done manual"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("history:\n%s", describeRuns(runs))
	}
	if l.ranIDs() != "in,out" {
		t.Fatalf("ran = %s", l.ranIDs())
	}
}

// The wait for an input another worker holds is bounded: past it the job is skipped, and the
// input goes on.
func TestCronLoopBoundsTheWaitForAFreshInput(t *testing.T) {
	var release func()
	l := startJobLoop(t, []cronstore.Task{manualOnly("in"), manualOnly("out", fresh("in"))},
		func(l *jobLoop) {
			release = l.holdJob("in")
			l.freshWait = 120 * time.Millisecond
		})
	defer release()
	l.mustStart("in")
	waitFor(t, "the input to start", func() bool {
		in := runsOf(l.history(), "in")
		return len(in) == 1 && in[0].Status == cronstore.RunStatusRunning
	})
	l.mustStart("out")
	waitFor(t, "the job to be skipped", func() bool {
		out := runsOf(l.history(), "out")
		return len(out) == 1 && out[0].Status == cronstore.RunStatusSkipped
	})
	out := runsOf(l.history(), "out")[0]
	if !strings.Contains(out.Cause.Note, "input job in was still queued or running after 120ms") {
		t.Fatalf("note = %q", out.Cause.Note)
	}
	if in := runsOf(l.history(), "in"); in[0].Status != cronstore.RunStatusRunning {
		t.Fatalf("the input did not go on: %+v", in[0])
	}
	release()
	l.waitSettled(2)
	if l.ranIDs() != "in" {
		t.Fatalf("ran = %s", l.ranIDs())
	}
}

// A job stopped while it waits for its input ends canceled and never runs.
func TestCronLoopStopsAJobThatWaitsForItsInput(t *testing.T) {
	var release func()
	l := startJobLoop(t, []cronstore.Task{manualOnly("in"), manualOnly("out", fresh("in"))},
		func(l *jobLoop) { release = l.holdJob("in") })
	defer release()
	l.mustStart("in")
	waitFor(t, "the input to start", func() bool {
		in := runsOf(l.history(), "in")
		return len(in) == 1 && in[0].Status == cronstore.RunStatusRunning
	})
	runID := l.mustStart("out")
	if got := cronstore.StopRun(l.store.Path, "out", runID); got.Status != cronstore.StopStopping {
		t.Fatalf("stop = %+v", got)
	}
	waitFor(t, "the job to end", func() bool {
		out := runsOf(l.history(), "out")
		return len(out) == 1 && out[0].Status == cronstore.RunStatusCanceled
	})
	release()
	l.waitSettled(2)
	if l.ranIDs() != "in" {
		t.Fatalf("ran = %s", l.ranIDs())
	}
}

// An input that is queued behind the job that needs it runs in that job's worker, at once, and
// the queue's own copy of it is dropped: one run, not two, and no worker waits on itself.
func TestCronLoopRunsAQueuedFreshInputInPlace(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cron.yaml")
	store := cronstore.NewStore(path)
	t.Cleanup(store.Close)
	tasks := []cronstore.Task{manualOnly("in"), manualOnly("out", fresh("in"))}
	if err := store.Write(cronstore.File{Tasks: tasks}); err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var ran []string
	r := newCronLoopRunner(CronLoopOptions{Path: path, Run: func(_ context.Context, due cronstore.DueTask) error {
		mu.Lock()
		ran = append(ran, due.Task.ID)
		mu.Unlock()
		return nil
	}})
	ctx := context.Background()
	inRunID, err := r.enqueue(ctx, cronstore.DueTask{Task: tasks[0], Manual: true})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := r.enqueue(ctx, cronstore.DueTask{Task: tasks[1], Manual: true}); err != nil {
		t.Fatal(err)
	}
	// A worker reaches "out" first.
	in, out := <-r.queue, <-r.queue
	if !r.takePending("out", out.RunID) {
		t.Fatal("out was not pending")
	}
	if status := r.runItem(ctx, "out", out); status != cronstore.RunStatusDone {
		t.Fatalf("out ended %s", status)
	}
	if r.takePending("in", in.RunID) {
		t.Fatal("the queue's copy of the input would run again")
	}
	if got := strings.Join(ran, ","); got != "in,out" {
		t.Fatalf("ran = %s", got)
	}
	runs, err := store.RunHistory(ctx, cronstore.RunHistoryQuery{})
	if err != nil || len(runs) != 2 {
		t.Fatalf("history = %+v, %v", runs, err)
	}
	for _, run := range runs {
		if run.Status != cronstore.RunStatusDone || (run.JobID == "in" && run.RunID != inRunID) {
			t.Fatalf("run = %+v", run)
		}
	}
}
