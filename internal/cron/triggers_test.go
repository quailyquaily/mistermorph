package cron

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// asStored returns tasks as the store reads them back: each with its trigger list, which for a
// task written with only at or cron is the one schedule trigger those make.
func asStored(tasks ...Task) []Task {
	out := make([]Task, len(tasks))
	for i, task := range tasks {
		task.Triggers = TriggersForTask(task)
		out[i] = task
	}
	return out
}

func newTriggerStore(t *testing.T) *Store {
	t.Helper()
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	t.Cleanup(store.Close)
	return store
}

func mustWrite(t *testing.T, store *Store, tasks ...Task) {
	t.Helper()
	if err := store.Write(File{Tasks: tasks}); err != nil {
		t.Fatalf("Write: %v", err)
	}
}

func mustFind(t *testing.T, store *Store, id string) Task {
	t.Helper()
	task, ok, err := store.FindByID(id)
	if err != nil || !ok {
		t.Fatalf("FindByID(%s) = %v, %v", id, ok, err)
	}
	return task
}

// A job written with only at, cron and tz, by a client that knows nothing else, reads back with
// the one schedule trigger those make, and its legacy fields are as they were written.
func TestLegacyTaskReadsBackWithOneScheduleTrigger(t *testing.T) {
	cases := []struct {
		name string
		task Task
		want Trigger
	}{
		{"cron", Task{ID: "a", Cron: "0 9 * * *", TZ: "UTC+8", Content: "x"},
			Trigger{ID: LegacyScheduleTriggerID, Kind: TriggerSchedule, Cron: "0 9 * * *", TZ: "UTC+8"}},
		{"at", Task{ID: "a", At: "2030-01-01 10:00", Content: "x"},
			Trigger{ID: LegacyScheduleTriggerID, Kind: TriggerSchedule, At: "2030-01-01 10:00"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTriggerStore(t)
			mustWrite(t, store, tc.task)
			got := mustFind(t, store, "a")
			if !reflect.DeepEqual(got.Triggers, []Trigger{tc.want}) {
				t.Fatalf("triggers = %+v, want %+v", got.Triggers, tc.want)
			}
			if got.At != tc.task.At || got.Cron != tc.task.Cron || got.TZ != tc.task.TZ {
				t.Fatalf("legacy fields = %q %q %q", got.At, got.Cron, got.TZ)
			}
		})
	}

	t.Run("a row stored before triggers", func(t *testing.T) {
		store := newTriggerStore(t)
		db, err := store.handle(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO jobs (id, position, content, cron, tz, created_at, updated_at)
			VALUES ('old', 0, 'c', '*/5 * * * *', 'UTC', 'now', 'now')`); err != nil {
			t.Fatal(err)
		}
		got := mustFind(t, store, "old")
		want := []Trigger{{ID: LegacyScheduleTriggerID, Kind: TriggerSchedule, Cron: "*/5 * * * *", TZ: "UTC"}}
		if !reflect.DeepEqual(got.Triggers, want) {
			t.Fatalf("triggers = %+v, want %+v", got.Triggers, want)
		}
	})

	t.Run("without at or cron it is refused, as before", func(t *testing.T) {
		store := newTriggerStore(t)
		err := store.Write(File{Tasks: []Task{{ID: "a", Content: "x"}}})
		if err == nil || !strings.Contains(err.Error(), "must use exactly one of at or cron") {
			t.Fatalf("err = %v", err)
		}
	})
}

// A trigger list is authoritative: at, cron and tz mirror its first schedule trigger and are
// empty without one, whatever the client sent in them.
func TestTriggerListIsAuthoritativeAndMirrored(t *testing.T) {
	cases := []struct {
		name            string
		task            Task
		wantAt, wantTZ  string
		wantCron        string
		wantKinds       string
		wantGeneratedID bool
	}{
		{
			name: "first schedule trigger is mirrored",
			task: Task{ID: "a", Content: "x", Cron: "1 1 1 1 1", Triggers: []Trigger{
				{ID: "p", Kind: TriggerPoke},
				{ID: "s1", Kind: TriggerSchedule, Cron: "0 9 * * *", TZ: "UTC"},
				{ID: "s2", Kind: TriggerSchedule, At: "2030-01-01 10:00"},
			}},
			wantCron: "0 9 * * *", wantTZ: "UTC", wantKinds: "poke,schedule,schedule",
		},
		{
			name:      "no schedule trigger clears the legacy fields",
			task:      Task{ID: "a", Content: "x", Cron: "0 9 * * *", TZ: "UTC", Triggers: []Trigger{{ID: "p", Kind: TriggerPoke}}},
			wantKinds: "poke",
		},
		{
			name:      "an empty list is a job only a person starts",
			task:      Task{ID: "a", Content: "x", At: "2030-01-01 10:00", Triggers: []Trigger{}},
			wantKinds: "",
		},
		{
			name: "a trigger without an id gets one, and fields of another kind are dropped",
			task: Task{ID: "a", Content: "x", Triggers: []Trigger{
				{Kind: " Message ", Channel: " Telegram ", ChatID: " tg:-1 ", Cron: "* * * * *"},
			}},
			wantKinds: "message", wantGeneratedID: true,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTriggerStore(t)
			mustWrite(t, store, tc.task)
			got := mustFind(t, store, "a")
			if got.At != tc.wantAt || got.Cron != tc.wantCron || got.TZ != tc.wantTZ {
				t.Fatalf("legacy fields = at %q cron %q tz %q", got.At, got.Cron, got.TZ)
			}
			var kinds []string
			for _, trigger := range got.Triggers {
				kinds = append(kinds, trigger.Kind)
				if trigger.ID == "" {
					t.Fatalf("trigger without id: %+v", trigger)
				}
			}
			if strings.Join(kinds, ",") != tc.wantKinds || got.Triggers == nil {
				t.Fatalf("triggers = %+v", got.Triggers)
			}
			if tc.wantGeneratedID {
				first := got.Triggers[0]
				if !strings.HasPrefix(first.ID, TriggerIDPrefix) || first.Channel != "telegram" || first.ChatID != "tg:-1" || first.Cron != "" {
					t.Fatalf("trigger = %+v", first)
				}
				// The ID is stable: saving the job again as read keeps it.
				mustWrite(t, store, got)
				if again := mustFind(t, store, "a"); again.Triggers[0].ID != first.ID {
					t.Fatalf("trigger id changed: %s -> %s", first.ID, again.Triggers[0].ID)
				}
			}
		})
	}
}

// A client that knows only at, cron and tz saves a job that has more: its schedule edit lands on
// the first schedule trigger, and what it cannot see is kept.
func TestLegacyWriteKeepsWhatItCannotSee(t *testing.T) {
	full := []Task{
		{ID: "src", Content: "x", Triggers: []Trigger{}},
		{ID: "a", Content: "x", Join: JoinAny, Uses: []Use{{JobID: "src", Mode: UseEach}}, Triggers: []Trigger{
			{ID: "p", Kind: TriggerPoke},
			{ID: "s1", Kind: TriggerSchedule, Cron: "0 9 * * *", TZ: "UTC"},
			{ID: "s2", Kind: TriggerSchedule, Cron: "0 18 * * *"},
		}},
	}
	cases := []struct {
		name string
		// edit returns the task the client sends for job a, given the job as it read it.
		edit         func(read Task) Task
		wantTriggers []Trigger
		wantErr      string
	}{
		{
			name: "unchanged legacy fields change nothing",
			edit: func(read Task) Task {
				return Task{ID: "a", Content: "edited", Cron: read.Cron, TZ: read.TZ}
			},
			wantTriggers: full[1].Triggers,
		},
		{
			name: "a new cron replaces the first schedule trigger",
			edit: func(read Task) Task { return Task{ID: "a", Content: "x", Cron: "30 7 * * *"} },
			wantTriggers: []Trigger{
				{ID: "p", Kind: TriggerPoke},
				{ID: "s1", Kind: TriggerSchedule, Cron: "30 7 * * *"},
				{ID: "s2", Kind: TriggerSchedule, Cron: "0 18 * * *"},
			},
		},
		{
			name: "switching to a one-time job",
			edit: func(read Task) Task { return Task{ID: "a", Content: "x", At: "2030-01-01 10:00", TZ: "UTC"} },
			wantTriggers: []Trigger{
				{ID: "p", Kind: TriggerPoke},
				{ID: "s1", Kind: TriggerSchedule, At: "2030-01-01 10:00", TZ: "UTC"},
				{ID: "s2", Kind: TriggerSchedule, Cron: "0 18 * * *"},
			},
		},
		{
			name: "a client that sends back the list it read, with at edited",
			edit: func(read Task) Task {
				read.Cron, read.At, read.TZ = "", "2031-02-03 04:05", ""
				return read
			},
			wantTriggers: []Trigger{
				{ID: "p", Kind: TriggerPoke},
				{ID: "s1", Kind: TriggerSchedule, At: "2031-02-03 04:05"},
				{ID: "s2", Kind: TriggerSchedule, Cron: "0 18 * * *"},
			},
		},
		{
			name: "a changed list wins over the legacy fields sent with it",
			edit: func(read Task) Task {
				read.Cron = "1 2 3 4 5"
				read.Triggers = []Trigger{{ID: "s2", Kind: TriggerSchedule, Cron: "0 18 * * *"}}
				return read
			},
			wantTriggers: []Trigger{{ID: "s2", Kind: TriggerSchedule, Cron: "0 18 * * *"}},
		},
		{
			name:    "clearing the schedule is refused, as before",
			edit:    func(read Task) Task { return Task{ID: "a", Content: "x", TZ: "UTC+1"} },
			wantErr: "must use exactly one of at or cron",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTriggerStore(t)
			mustWrite(t, store, append([]Task(nil), full...)...)
			sent := tc.edit(mustFind(t, store, "a"))
			// The other job goes back as a legacy client sends it: without a list.
			err := store.Write(File{Tasks: []Task{{ID: "src", Content: "x"}, sent}})
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got := mustFind(t, store, "a")
			if !reflect.DeepEqual(got.Triggers, tc.wantTriggers) {
				t.Fatalf("triggers = %+v\nwant %+v", got.Triggers, tc.wantTriggers)
			}
			if first, _ := TriggerOfKind(got, TriggerSchedule); got.At != first.At || got.Cron != first.Cron || got.TZ != first.TZ {
				t.Fatalf("legacy fields %q %q %q do not mirror %+v", got.At, got.Cron, got.TZ, first)
			}
			if got.Join != JoinAny || !reflect.DeepEqual(got.Uses, []Use{{JobID: "src", Mode: UseEach}}) {
				t.Fatalf("uses = %+v join = %q", got.Uses, got.Join)
			}
			// A job no schedule starts survives the legacy client's save of the list.
			if src := mustFind(t, store, "src"); len(src.Triggers) != 0 || src.At != "" || src.Cron != "" {
				t.Fatalf("src = %+v", src)
			}
		})
	}
}

// job_manage's update edits at, cron and tz: they land on the first schedule trigger.
func TestUpdatePatchesTheFirstScheduleTrigger(t *testing.T) {
	store := newTriggerStore(t)
	mustWrite(t, store, Task{ID: "a", Content: "x", Triggers: []Trigger{
		{ID: "p", Kind: TriggerPoke},
		{ID: "s1", Kind: TriggerSchedule, Cron: "0 9 * * *"},
	}})
	at := "2030-01-01 10:00"
	if _, err := store.Update(context.Background(), "a", TaskPatch{At: &at}); err != nil {
		t.Fatal(err)
	}
	got := mustFind(t, store, "a")
	want := []Trigger{{ID: "p", Kind: TriggerPoke}, {ID: "s1", Kind: TriggerSchedule, At: at}}
	if !reflect.DeepEqual(got.Triggers, want) || got.At != at || got.Cron != "" {
		t.Fatalf("task = %+v", got)
	}
}

// The scheduler fires a job on any of its schedule triggers, naming the one that fired, and never
// by the clock without one.
func TestDueOnAnyScheduleTrigger(t *testing.T) {
	store := newTriggerStore(t)
	mustWrite(t, store,
		Task{ID: "multi", Content: "x", Triggers: []Trigger{
			{ID: "morning", Kind: TriggerSchedule, Cron: "0 9 * * *", TZ: "UTC"},
			{ID: "evening", Kind: TriggerSchedule, Cron: "0 18 * * *", TZ: "UTC"},
			{ID: "once", Kind: TriggerSchedule, At: "2030-01-02 12:00", TZ: "UTC"},
		}},
		Task{ID: "poke-only", Content: "x", Triggers: []Trigger{{ID: "p", Kind: TriggerPoke}}},
		Task{ID: "none", Content: "x", Triggers: []Trigger{}},
		Task{ID: "legacy", Content: "x", Cron: "0 9 * * *", TZ: "UTC"},
	)
	cases := []struct {
		name string
		now  time.Time
		want map[string]string // job -> trigger that fired
	}{
		{"morning", time.Date(2030, 1, 1, 9, 0, 0, 0, time.UTC), map[string]string{"multi": "morning", "legacy": LegacyScheduleTriggerID}},
		{"evening", time.Date(2030, 1, 1, 18, 0, 0, 0, time.UTC), map[string]string{"multi": "evening"}},
		{"between", time.Date(2030, 1, 1, 13, 0, 0, 0, time.UTC), map[string]string{}},
		{"the one-time trigger, once its time has come", time.Date(2030, 1, 2, 12, 30, 0, 0, time.UTC), map[string]string{"multi": "once"}},
		{"two at once start one run, by the first", time.Date(2030, 1, 3, 9, 0, 0, 0, time.UTC), map[string]string{"multi": "morning", "legacy": LegacyScheduleTriggerID}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			due, taskErrs, err := store.DueLenient(tc.now)
			if err != nil || len(taskErrs) != 0 {
				t.Fatalf("DueLenient: %v %v", err, taskErrs)
			}
			got := map[string]string{}
			for _, item := range due {
				if item.Cause.Kind != CauseSchedule {
					t.Fatalf("cause = %+v", item.Cause)
				}
				got[item.Task.ID] = item.Cause.TriggerID
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("due = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSaveValidatesTriggersUsesAndJoin(t *testing.T) {
	job := func(id string, uses ...Use) Task {
		return Task{ID: id, Content: "x", Triggers: []Trigger{}, Uses: uses}
	}
	each := func(id string) Use { return Use{JobID: id, Mode: UseEach} }
	var nine []Use
	var nineJobs []Task
	for i := 0; i < MaxUses+1; i++ {
		id := fmt.Sprintf("in%d", i)
		nine = append(nine, Use{JobID: id, Mode: UseLatest})
		nineJobs = append(nineJobs, job(id))
	}
	cases := []struct {
		name    string
		tasks   []Task
		wantErr string // "" for a list that saves
	}{
		{"a chain and a diamond save", []Task{job("a"), job("b", each("a")), job("c", each("a")), job("d", each("b"), Use{JobID: "c", Mode: UseFresh})}, ""},
		{"eight uses save", append(append([]Task{}, nineJobs[:MaxUses]...), job("a", nine[:MaxUses]...)), ""},
		{"unknown job", []Task{job("a", each("ghost"))}, "task a uses unknown job: ghost"},
		{"a job using itself", []Task{job("a", each("a"))}, "task a cannot use itself"},
		{"a loop of two", []Task{job("a", each("b")), job("b", each("a"))}, "jobs use each other in a loop: a -> b -> a"},
		{"a loop of three, entered from outside", []Task{job("x", each("a")), job("a", each("b")), job("b", each("c")), job("c", each("a"))},
			"jobs use each other in a loop: a -> b -> c -> a"},
		{"the same job twice", []Task{job("a"), job("b", each("a"), Use{JobID: "a", Mode: UseLatest})}, "task b uses job a more than once"},
		{"more than eight uses", append(append([]Task{}, nineJobs...), job("a", nine...)), "task a uses 9 jobs; the limit is 8"},
		{"unknown mode", []Task{job("a"), job("b", Use{JobID: "a", Mode: "sometimes"})}, `unknown use mode "sometimes"`},
		{"a use without a job", []Task{job("b", Use{Mode: UseEach})}, "a use needs a job_id"},
		{"a fresh use with a max age saves", []Task{job("a"), job("b", Use{JobID: "a", Mode: UseFresh, MaxAge: "90m"})}, ""},
		{"a fresh use at the bounds saves", []Task{job("a"), job("c"), job("b", Use{JobID: "a", Mode: UseFresh, MaxAge: "1m"}, Use{JobID: "c", Mode: UseFresh, MaxAge: "720h"})}, ""},
		{"a max age that is not a duration", []Task{job("a"), job("b", Use{JobID: "a", Mode: UseFresh, MaxAge: "1 day"})}, `invalid max_age "1 day" for job a`},
		{"a max age below the bound", []Task{job("a"), job("b", Use{JobID: "a", Mode: UseFresh, MaxAge: "30s"})}, "max_age 30s for job a is out of range"},
		{"a max age above the bound", []Task{job("a"), job("b", Use{JobID: "a", Mode: UseFresh, MaxAge: "721h"})}, "max_age 721h for job a is out of range"},
		{"a max age on another mode", []Task{job("a"), job("b", Use{JobID: "a", Mode: UseEach, MaxAge: "1h"})}, "max_age for job a needs mode fresh"},
		{"unknown join", []Task{{ID: "a", Content: "x", Triggers: []Trigger{}, Join: "most"}}, `unknown join "most"`},
		{"unknown trigger kind", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{Kind: "webhook"}}}}, `unknown trigger kind "webhook"`},
		{"a schedule trigger without a time", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{Kind: TriggerSchedule}}}}, "task a must use exactly one of at or cron"},
		{"a schedule trigger with both", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{Kind: TriggerSchedule, At: "2030-01-01 10:00", Cron: "* * * * *"}}}}, "task a must use exactly one of at or cron"},
		{"a schedule trigger with a bad cron", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{Kind: TriggerSchedule, Cron: "nope"}}}}, "invalid cron for task a"},
		{"a schedule trigger with a bad timezone", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{Kind: TriggerSchedule, Cron: "* * * * *", TZ: "Mars/Olympus"}}}}, "invalid timezone: Mars/Olympus"},
		{"a message trigger without a channel", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{Kind: TriggerMessage, ChatID: "tg:1"}}}}, "a message trigger needs a channel"},
		{"a message trigger without a chat", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{Kind: TriggerMessage, Channel: "slack"}}}}, "a message trigger needs a chat_id"},
		{"two triggers with one id", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{ID: "t", Kind: TriggerPoke}, {ID: "t", Kind: TriggerSchedule, Cron: "* * * * *"}}}}, "duplicate trigger id: t"},
		{"two poke triggers", []Task{{ID: "a", Content: "x", Triggers: []Trigger{{Kind: TriggerPoke}, {Kind: TriggerPoke}}}}, "more than one poke trigger"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTriggerStore(t)
			mustWrite(t, store, Task{ID: "kept", Content: "x", Cron: "* * * * *"})
			err := store.Write(File{Tasks: tc.tasks})
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("err = %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
			// A refused save changes nothing.
			if tasks, _ := store.Tasks(context.Background()); jobIDs(tasks) != "kept" {
				t.Fatalf("list after a refused save = %s", jobIDs(tasks))
			}
		})
	}
}

// A job other jobs use is not deleted: the refusal names them, and their links stay.
func TestDeleteRefusedWhileUsed(t *testing.T) {
	seed := func(t *testing.T) *Store {
		store := newTriggerStore(t)
		mustWrite(t, store,
			Task{ID: "src", Content: "x", Cron: "0 9 * * *"},
			Task{ID: "b", Content: "x", Triggers: []Trigger{}, Uses: []Use{{JobID: "src", Mode: UseEach}}},
			Task{ID: "c", Content: "x", Triggers: []Trigger{}, Uses: []Use{{JobID: "src", Mode: UseLatest}}},
			Task{ID: "free", Content: "x", Cron: "0 9 * * *"},
		)
		return store
	}
	cases := []struct {
		name    string
		delete  func(store *Store) error
		wantErr string
		wantIDs string
	}{
		{"by id", func(s *Store) error { _, err := s.DeleteByID("src"); return err }, "src is used by b, c; remove it from their uses first", "src,b,c,free"},
		{"by leaving it out of a saved list", func(s *Store) error {
			tasks, _ := s.Tasks(context.Background())
			return s.Write(File{Tasks: tasks[1:]})
		}, "src is used by b, c", "src,b,c,free"},
		{"a job nothing uses", func(s *Store) error { _, err := s.DeleteByID("free"); return err }, "", "src,b,c"},
		{"a user of it", func(s *Store) error { _, err := s.DeleteByID("b"); return err }, "", "src,c,free"},
		{"it and its users together", func(s *Store) error {
			tasks, _ := s.Tasks(context.Background())
			return s.Write(File{Tasks: tasks[3:]})
		}, "", "free"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := seed(t)
			err := tc.delete(store)
			if tc.wantErr == "" && err != nil {
				t.Fatalf("err = %v", err)
			}
			if tc.wantErr != "" && (!errors.Is(err, ErrJobInUse) || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
			tasks, _ := store.Tasks(context.Background())
			if jobIDs(tasks) != tc.wantIDs {
				t.Fatalf("list = %s, want %s", jobIDs(tasks), tc.wantIDs)
			}
			if tc.wantErr != "" && len(mustFind(t, store, "b").Uses) != 1 {
				t.Fatal("a refused delete dropped a link")
			}
		})
	}
}

// A one-time trigger that has run is retired: the job goes with it only when nothing else starts
// it and no job uses it.
func TestConsumeOnceTrigger(t *testing.T) {
	once := Trigger{ID: "once", Kind: TriggerSchedule, At: "2030-01-01 10:00"}
	cases := []struct {
		name        string
		tasks       []Task
		trigger     string
		wantDeleted bool
		wantIDs     string
		wantLeft    int // triggers left on job a, when it stays
	}{
		{"a legacy one-time job is deleted", []Task{{ID: "a", Content: "x", At: "2030-01-01 10:00"}}, LegacyScheduleTriggerID, true, "", 0},
		{"a job with another trigger stays", []Task{{ID: "a", Content: "x", Triggers: []Trigger{once, {ID: "p", Kind: TriggerPoke}}}}, "once", false, "a", 1},
		{"a job another uses stays", []Task{{ID: "a", Content: "x", Triggers: []Trigger{once}},
			{ID: "b", Content: "x", Triggers: []Trigger{}, Uses: []Use{{JobID: "a", Mode: UseEach}}}}, "once", false, "a,b", 0},
		{"a recurring trigger is not retired", []Task{{ID: "a", Content: "x", Cron: "* * * * *"}}, LegacyScheduleTriggerID, false, "a", 1},
		{"an unknown trigger changes nothing", []Task{{ID: "a", Content: "x", Triggers: []Trigger{once}}}, "gone", false, "a", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTriggerStore(t)
			mustWrite(t, store, tc.tasks...)
			deleted, err := store.ConsumeOnceTrigger(context.Background(), "a", tc.trigger)
			if err != nil || deleted != tc.wantDeleted {
				t.Fatalf("ConsumeOnceTrigger = %v, %v", deleted, err)
			}
			tasks, _ := store.Tasks(context.Background())
			if jobIDs(tasks) != tc.wantIDs {
				t.Fatalf("list = %s, want %s", jobIDs(tasks), tc.wantIDs)
			}
			if !deleted {
				if a := mustFind(t, store, "a"); len(a.Triggers) != tc.wantLeft {
					t.Fatalf("triggers = %+v", a.Triggers)
				}
			}
		})
	}
}

// The JSON of a job always lists its triggers, and takes them back.
func TestTaskJSONShape(t *testing.T) {
	cases := []struct {
		name string
		task Task
		want string
	}{
		{"a stored legacy task shows its schedule trigger", asStored(Task{ID: "a", Cron: "0 9 * * *", TZ: "UTC", Content: "x"})[0],
			`{"id":"a","cron":"0 9 * * *","tz":"UTC","content":"x","triggers":[{"id":"trg-schedule","kind":"schedule","cron":"0 9 * * *","tz":"UTC"}]}`},
		{"a task that is not a stored job (the heartbeat) has no list", HeartbeatTask("0 * * * *"),
			`{"id":"__heartbeat__","title":"Heartbeat","cron":"0 * * * *","content":"Run heartbeat checklist."}`},
		{"a task nothing starts shows an empty list", Task{ID: "a", Content: "x", Triggers: []Trigger{}},
			`{"id":"a","content":"x","triggers":[]}`},
		{"every kind, uses and join", Task{ID: "a", Content: "x", Join: JoinAny,
			Uses: []Use{{JobID: "b", Mode: UseEach}},
			Triggers: []Trigger{{ID: "p", Kind: TriggerPoke}, {ID: "m", Kind: TriggerMessage, Channel: "telegram", ChatID: "tg:-1"},
				{ID: "s", Kind: TriggerSchedule, At: "2030-01-01 10:00"}}},
			`{"id":"a","content":"x","triggers":[{"id":"p","kind":"poke"},{"id":"m","kind":"message","channel":"telegram","chat_id":"tg:-1"},{"id":"s","kind":"schedule","at":"2030-01-01 10:00"}],"uses":[{"job_id":"b","mode":"each"}],"join":"any"}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.task)
			if err != nil || string(raw) != tc.want {
				t.Fatalf("json = %s (%v)\nwant %s", raw, err, tc.want)
			}
			var back Task
			if err := json.Unmarshal(raw, &back); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(back.Triggers, tc.task.Triggers) || !reflect.DeepEqual(back.Uses, tc.task.Uses) {
				t.Fatalf("back = %+v", back)
			}
		})
	}
	// A client that leaves the list out sends a legacy write: the list decodes as nil.
	var legacy Task
	if err := json.Unmarshal([]byte(`{"id":"a","cron":"* * * * *","content":"x"}`), &legacy); err != nil || legacy.Triggers != nil {
		t.Fatalf("legacy = %+v, %v", legacy, err)
	}
}

func TestFreshMaxAge(t *testing.T) {
	cases := []struct {
		raw  string
		want time.Duration
	}{
		{"", DefaultFreshMaxAge},
		{"15m", 15 * time.Minute},
		{" 24h ", 24 * time.Hour},
		{"nonsense", DefaultFreshMaxAge},
		{"1s", DefaultFreshMaxAge},
	}
	for _, tc := range cases {
		if got := FreshMaxAge(Use{JobID: "a", Mode: UseFresh, MaxAge: tc.raw}); got != tc.want {
			t.Fatalf("FreshMaxAge(%q) = %s, want %s", tc.raw, got, tc.want)
		}
	}
	if DefaultFreshMaxAge != time.Hour {
		t.Fatalf("default max age = %s", DefaultFreshMaxAge)
	}
}
