package cron

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestJoinWarnings(t *testing.T) {
	job := func(id string, uses ...Use) Task {
		return Task{ID: id, Content: "x", Triggers: []Trigger{}, Uses: uses}
	}
	each := func(id string) Use { return Use{JobID: id, Mode: UseEach} }
	joinAny := func(task Task) Task {
		task.Join = JoinAny
		return task
	}
	cases := []struct {
		name  string
		tasks []Task
		// want is the IDs of the jobs warned about, in order, joined with commas.
		want string
	}{
		{"no uses", []Task{job("a"), job("b")}, ""},
		{"one each input", []Task{job("a"), job("d", each("a"))}, ""},
		{"two unrelated inputs, join all", []Task{job("a"), job("b"), job("d", each("a"), each("b"))}, "d"},
		{"two unrelated inputs, join any", []Task{job("a"), job("b"), joinAny(job("d", each("a"), each("b")))}, ""},
		{"a diamond: one root starts both", []Task{job("root"), job("a", each("root")), job("b", each("root")), job("d", each("a"), each("b"))}, ""},
		{"one input starts the other", []Task{job("a"), job("b", each("a")), job("d", each("a"), each("b"))}, ""},
		{"a deeper common root", []Task{job("root"), job("a", each("root")), job("mid", each("root")), job("b", each("mid")), job("d", each("a"), each("b"))}, ""},
		{"two roots, one branch each", []Task{job("r1"), job("r2"), job("a", each("r1")), job("b", each("r2")), job("d", each("a"), each("b"))}, "d"},
		{"three inputs, one outside", []Task{job("root"), job("a", each("root")), job("b", each("root")), job("c"), job("d", each("a"), each("b"), each("c"))}, "d"},
		{"an input that is only latest or fresh does not count", []Task{job("a"), job("b"), job("d", each("a"), Use{JobID: "b", Mode: UseLatest})}, ""},
		{"a job that needs the other input fresh brings it into its chain", []Task{job("b"), job("a", Use{JobID: "b", Mode: UseFresh}), job("d", each("a"), each("b"))}, ""},
		{"a latest link is no common root", []Task{job("root"), job("a", Use{JobID: "root", Mode: UseLatest}), job("b", each("root")), job("d", each("a"), each("b"))}, "d"},
		{"two such jobs", []Task{job("a"), job("b"), job("d", each("a"), each("b")), job("e", each("b"), each("a"))}, "d,e"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			warnings := JoinWarnings(tc.tasks)
			var ids []string
			for _, task := range tc.tasks {
				if list := warnings[task.ID]; len(list) > 0 {
					ids = append(ids, task.ID)
					if len(list) != 1 || !strings.Contains(list[0], "never starts") || !strings.Contains(list[0], strings.Join(EachInputs(task), ", ")) || strings.Contains(list[0], "\n") {
						t.Fatalf("warning of %s = %q", task.ID, list)
					}
				}
			}
			if got := strings.Join(ids, ","); got != tc.want || len(warnings) != len(ids) {
				t.Fatalf("warned = %q, want %q (%v)", got, tc.want, warnings)
			}
		})
	}
}

// A one-time schedule that used every try is warned about; one with tries left is not.
func TestWarningsOfAOneTimeScheduleThatGaveUp(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	t.Cleanup(store.Close)
	if err := store.Write(File{Tasks: []Task{
		{ID: "spent", At: "2030-01-02 09:00", TZ: "UTC", Content: "x"},
		{ID: "trying", At: "2030-01-02 09:00", TZ: "UTC", Content: "x"},
		{ID: "daily", Cron: "0 9 * * *", TZ: "UTC", Content: "x"},
	}}); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	at := time.Date(2030, 1, 2, 9, 0, 0, 0, time.UTC)
	fail := func(id string, times int) {
		for i := 0; i < times; i++ {
			run, err := store.RecordRun(ctx, RunRecord{JobID: id, QueuedAt: RunTime(at.Add(time.Duration(i) * time.Hour)),
				Cause: RunCause{Kind: CauseSchedule, TriggerID: LegacyScheduleTriggerID}})
			if err != nil {
				t.Fatal(err)
			}
			if err := store.MarkRunFinished(ctx, run.RunID, RunStatusFailed, "boom", "", at.Add(time.Duration(i)*time.Hour)); err != nil {
				t.Fatal(err)
			}
		}
		if err := store.RecordRunStart(id, at); err != nil {
			t.Fatal(err)
		}
		if err := store.RecordRunResult(id, RunStatusFailed); err != nil {
			t.Fatal(err)
		}
	}
	fail("spent", len(OnceRetryDelays)+1)
	fail("trying", 2)
	fail("daily", 9)
	tasks, err := store.Tasks(ctx)
	if err != nil {
		t.Fatal(err)
	}
	warnings := store.Warnings(ctx, tasks)
	if len(warnings) != 1 || len(warnings["spent"]) != 1 || !strings.Contains(warnings["spent"][0], "failed 5 times and is not tried again") {
		t.Fatalf("warnings = %v", warnings)
	}
}
