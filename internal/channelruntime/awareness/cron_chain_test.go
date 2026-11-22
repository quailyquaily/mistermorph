package awareness

import (
	"errors"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

func each(ids ...string) []cronstore.Use {
	uses := make([]cronstore.Use, 0, len(ids))
	for _, id := range ids {
		uses = append(uses, cronstore.Use{JobID: id})
	}
	return uses
}

// chainLines writes each run as "job status cause<-from", sorted, for comparing a whole chain.
func chainLines(runs []cronstore.RunRecord) []string {
	lines := make([]string, 0, len(runs))
	for _, run := range runs {
		line := fmt.Sprintf("%s %s %s", run.JobID, run.Status, run.Cause.Kind)
		if run.Cause.FromJobID != "" {
			line += "<-" + run.Cause.FromJobID
		}
		lines = append(lines, line)
	}
	sort.Strings(lines)
	return lines
}

func TestCronLoopChainsJobsThatUseEachRun(t *testing.T) {
	boom := errors.New("boom")
	off := false
	cases := []struct {
		name  string
		tasks []cronstore.Task
		fail  map[string]error
		// want is every run in the history once the chain has settled, as chainLines writes them.
		want []string
		// wantRan is the jobs that actually ran, sorted.
		wantRan string
		// wantNotes maps a job to what its skipped run's note must say.
		wantNotes map[string]string
	}{
		{
			name:    "each run that ends done starts the jobs that use it",
			tasks:   []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("b")...)},
			want:    []string{"a done manual", "b done job<-a", "c done job<-b"},
			wantRan: "a,b,c",
		},
		{
			name: "join all runs once, when every input is done",
			tasks: []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("a")...),
				{ID: "d", Content: "Run d.", Triggers: []cronstore.Trigger{}, Uses: each("b", "c"), Join: cronstore.JoinAll}},
			want:    []string{"a done manual", "b done job<-a", "c done job<-a", "d done job<-*"},
			wantRan: "a,b,c,d",
		},
		{
			name: "join all is the default",
			tasks: []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("a")...),
				manualOnly("d", each("b", "c")...)},
			want:    []string{"a done manual", "b done job<-a", "c done job<-a", "d done job<-*"},
			wantRan: "a,b,c,d",
		},
		{
			name: "join all waits for an input the chain never reaches",
			tasks: []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("never"),
				manualOnly("d", each("b", "never")...)},
			want:    []string{"a done manual", "b done job<-a"},
			wantRan: "a,b",
		},
		{
			name:      "a failed input skips the jobs that use it, down the chain",
			tasks:     []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("b")...)},
			fail:      map[string]error{"a": boom},
			want:      []string{"a failed manual", "b skipped job<-a", "c skipped job<-b"},
			wantRan:   "a",
			wantNotes: map[string]string{"b": "input job a failed", "c": "input job b was skipped"},
		},
		{
			name: "a failure in the middle skips only what is below it",
			tasks: []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("b")...),
				manualOnly("side", each("a")...)},
			fail:      map[string]error{"b": boom},
			want:      []string{"a done manual", "b failed job<-a", "c skipped job<-b", "side done job<-a"},
			wantRan:   "a,b,side",
			wantNotes: map[string]string{"c": "input job b failed"},
		},
		{
			name: "join all with a failed input is skipped and never runs",
			tasks: []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("a")...),
				manualOnly("d", each("b", "c")...)},
			fail:      map[string]error{"b": boom},
			want:      []string{"a done manual", "b failed job<-a", "c done job<-a", "d skipped job<-b"},
			wantRan:   "a,b,c",
			wantNotes: map[string]string{"d": "input job b failed"},
		},
		{
			name: "a job reached by two failed paths is skipped once",
			tasks: []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("a")...),
				manualOnly("d", each("b", "c")...)},
			fail:    map[string]error{"a": boom},
			want:    []string{"a failed manual", "b skipped job<-a", "c skipped job<-a", "d skipped job<-b"},
			wantRan: "a",
		},
		{
			name: "a chain stops at five jobs deep and says why",
			tasks: []cronstore.Task{manualOnly("j1"), manualOnly("j2", each("j1")...), manualOnly("j3", each("j2")...),
				manualOnly("j4", each("j3")...), manualOnly("j5", each("j4")...), manualOnly("j6", each("j5")...), manualOnly("j7", each("j6")...)},
			want: []string{"j1 done manual", "j2 done job<-j1", "j3 done job<-j2", "j4 done job<-j3", "j5 done job<-j4",
				"j6 skipped job<-j5"},
			wantRan:   "j1,j2,j3,j4,j5",
			wantNotes: map[string]string{"j6": fmt.Sprintf("more than %d jobs deep", cronstore.MaxChainDepth)},
		},
		{
			name: "a switched-off job is never queued by a chain",
			tasks: []cronstore.Task{manualOnly("a"),
				{ID: "b", Content: "Run b.", Enabled: &off, Triggers: []cronstore.Trigger{}, Uses: each("a")},
				manualOnly("c", each("b")...)},
			want:      []string{"a done manual", "b skipped job<-a", "c skipped job<-b"},
			wantRan:   "a",
			wantNotes: map[string]string{"b": "the job is switched off", "c": "input job b was skipped"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			l := startJobLoop(t, tc.tasks, func(l *jobLoop) {
				for id, err := range tc.fail {
					l.fail[id] = err
				}
			})
			originID := l.mustStart(tc.tasks[0].ID)
			runs := l.waitSettled(len(tc.want))
			got := chainLines(runs)
			want := append([]string(nil), tc.want...)
			// "<-*": the input that finished last started the job; either may have.
			for i, line := range want {
				if cut := strings.Index(line, "<-*"); cut >= 0 {
					for _, have := range got {
						if strings.HasPrefix(have, line[:cut]+"<-") {
							want[i] = have
						}
					}
				}
			}
			sort.Strings(want)
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("history:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
			}
			ran := strings.Split(l.ranIDs(), ",")
			sort.Strings(ran)
			if strings.Join(ran, ",") != tc.wantRan {
				t.Fatalf("ran = %v, want %s", ran, tc.wantRan)
			}
			for _, run := range runs {
				// Every run of the chain names the run that started it.
				if run.Cause.OriginRunID != originID {
					t.Fatalf("run of %s has origin %q, want %q", run.JobID, run.Cause.OriginRunID, originID)
				}
				if run.Status == cronstore.RunStatusSkipped && (run.StartedAt != "" || run.FinishedAt == "" || run.Cause.Note == "") {
					t.Fatalf("skipped run = %+v", run)
				}
				if note, ok := tc.wantNotes[run.JobID]; ok && !strings.Contains(run.Cause.Note, note) {
					t.Fatalf("note of %s = %q, want %q", run.JobID, run.Cause.Note, note)
				}
			}
		})
	}
}

// With join any, each input that ends done queues the job: two inputs, two runs.
func TestCronLoopChainJoinAnyRunsForEachInput(t *testing.T) {
	var releaseC func()
	l := startJobLoop(t, []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("a")...),
		{ID: "d", Content: "Run d.", Triggers: []cronstore.Trigger{}, Uses: each("b", "c"), Join: cronstore.JoinAny}},
		func(l *jobLoop) { releaseC = l.holdJob("c") })
	defer releaseC()
	originID := l.mustStart("a")
	// b ends first and queues d; c is still running.
	deadline := time.Now().Add(5 * time.Second)
	for {
		d := runsOf(l.history(), "d")
		if len(d) == 1 && d[0].Status == cronstore.RunStatusDone {
			if d[0].Cause.FromJobID != "b" {
				t.Fatalf("first run of d = %+v", d[0])
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("d did not run after b:\n%s", describeRuns(l.history()))
		}
		time.Sleep(10 * time.Millisecond)
	}
	releaseC()
	runs := l.waitSettled(5)
	want := []string{"a done manual", "b done job<-a", "c done job<-a", "d done job<-b", "d done job<-c"}
	if got := chainLines(runs); !reflect.DeepEqual(got, want) {
		t.Fatalf("history:\n%s", strings.Join(got, "\n"))
	}
	for _, run := range runs {
		if run.Cause.OriginRunID != originID {
			t.Fatalf("run of %s has origin %q, want %q", run.JobID, run.Cause.OriginRunID, originID)
		}
	}
}

// With join any, an input that ends while the job is still running from another does not queue a
// second run on top of it: the history says it was skipped.
func TestCronLoopChainJoinAnyWhileTheJobIsBusy(t *testing.T) {
	var releaseC, releaseD func()
	l := startJobLoop(t, []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("a")...),
		{ID: "d", Content: "Run d.", Triggers: []cronstore.Trigger{}, Uses: each("b", "c"), Join: cronstore.JoinAny}},
		func(l *jobLoop) { releaseC, releaseD = l.holdJob("c"), l.holdJob("d") })
	defer releaseC()
	defer releaseD()
	l.mustStart("a")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if d := runsOf(l.history(), "d"); len(d) == 1 && d[0].Status == cronstore.RunStatusRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("d did not start:\n%s", describeRuns(l.history()))
		}
		time.Sleep(10 * time.Millisecond)
	}
	releaseC()
	for {
		if len(runsOf(l.history(), "d")) == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("c's end left no record for d:\n%s", describeRuns(l.history()))
		}
		time.Sleep(10 * time.Millisecond)
	}
	releaseD()
	runs := l.waitSettled(5)
	want := []string{"a done manual", "b done job<-a", "c done job<-a", "d done job<-b", "d skipped job<-c"}
	if got := chainLines(runs); !reflect.DeepEqual(got, want) {
		t.Fatalf("history:\n%s", strings.Join(got, "\n"))
	}
	for _, run := range runsOf(runs, "d") {
		if run.Status == cronstore.RunStatusSkipped && !strings.Contains(run.Cause.Note, "already queued or running") {
			t.Fatalf("skipped run = %+v", run)
		}
	}
}

// A run a person stops is canceled: the jobs that use it are skipped, as for a failure.
func TestCronLoopChainSkipsAfterACanceledInput(t *testing.T) {
	var release func()
	l := startJobLoop(t, []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...)},
		func(l *jobLoop) { release = l.holdJob("a") })
	defer release()
	runID := l.mustStart("a")
	deadline := time.Now().Add(5 * time.Second)
	for {
		if a := runsOf(l.history(), "a"); len(a) == 1 && a[0].Status == cronstore.RunStatusRunning {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("a did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := cronstore.StopRun(l.store.Path, "a", runID); got.Status != cronstore.StopStopping {
		t.Fatalf("stop = %+v", got)
	}
	runs := l.waitSettled(2)
	if got, want := chainLines(runs), []string{"a canceled manual", "b skipped job<-a"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("history:\n%s", strings.Join(got, "\n"))
	}
	if b := runsOf(runs, "b")[0]; b.Cause.Note != "input job a was canceled" || b.Cause.OriginRunID != runID {
		t.Fatalf("b = %+v", b)
	}
	if l.ranIDs() != "a" {
		t.Fatalf("ran = %s", l.ranIDs())
	}
}

// A chain started by a schedule keeps that run as its origin, and a second chain of the same jobs
// is counted on its own: a job that joins all waits for the inputs of its own chain.
func TestCronLoopChainsAreKeptApartByOrigin(t *testing.T) {
	boom := errors.New("boom")
	l := startJobLoop(t, []cronstore.Task{manualOnly("a"), manualOnly("b", each("a")...), manualOnly("c", each("a")...),
		manualOnly("d", each("b", "c")...)},
		func(l *jobLoop) { l.fail["c"] = boom })
	first := l.mustStart("a")
	l.waitSettled(4) // a, b done; c failed; d skipped
	l.mu.Lock()
	delete(l.fail, "c")
	l.fail["b"] = boom
	l.mu.Unlock()
	second := l.mustStart("a")
	runs := l.waitSettled(8)
	// b is done in the first chain and c in the second: d has both inputs done, but never in one
	// chain, so it never runs.
	for _, run := range runsOf(runs, "d") {
		if run.Status != cronstore.RunStatusSkipped {
			t.Fatalf("d ran across two chains: %+v", run)
		}
	}
	byOrigin := map[string]int{}
	for _, run := range runs {
		byOrigin[run.Cause.OriginRunID]++
	}
	if first == second || byOrigin[first] != 4 || byOrigin[second] != 4 {
		t.Fatalf("runs by origin = %v (first %s, second %s)", byOrigin, first, second)
	}
}
