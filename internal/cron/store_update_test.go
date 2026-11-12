package cron

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
)

// syntheticSecret stands for a credential in a task's bash_env; it must never show up in errors.
const syntheticSecret = "synthetic-secret-value-0001"

func strPtr(v string) *string { return &v }

func envPtr(refs ...BashEnvRef) *[]BashEnvRef {
	if refs == nil {
		refs = []BashEnvRef{}
	}
	return &refs
}

// reloadStore drops the process's open handle on the store's agent.db, so the next read comes
// from the file.
func reloadStore(t *testing.T, store *Store) *Store {
	t.Helper()
	if err := agentdb.CachedBeside(store.Path).Close(); err != nil {
		t.Fatal(err)
	}
	return NewStore(store.Path)
}

type taskRowMeta struct {
	position             int
	createdAt, updatedAt string
}

func readTaskRowMeta(t *testing.T, store *Store, id string) taskRowMeta {
	t.Helper()
	db, err := agentdb.CachedBeside(store.Path).Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var meta taskRowMeta
	if err := db.QueryRowContext(context.Background(), `SELECT position, created_at, updated_at FROM cron_tasks WHERE id = ?`, id).
		Scan(&meta.position, &meta.createdAt, &meta.updatedAt); err != nil {
		t.Fatal(err)
	}
	return meta
}

func fullTask(kind string) Task {
	off := false
	task := Task{
		ID: "report-" + kind, Title: "Report " + kind, Enabled: &off, TZ: "Asia/Tokyo", Content: "Send the report",
		ChatID: "tg:-1001", Mention: "@john", LLMProfile: "batch", WorkspaceDir: "/srv/reports",
		BashEnv: []BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}, {Name: "API_TOKEN", Value: syntheticSecret}},
	}
	if kind == "once" {
		task.At = "2030-01-02 09:00"
	} else {
		task.Cron = "0 10 * * 1"
	}
	return task
}

func TestStoreAddKeepsBashEnvForBothKinds(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	env := []BashEnvRef{{Name: " REPORT_MODE ", Value: "weekly"}, {Name: "API_TOKEN", Value: "${SYNTHETIC_TOKEN}"}}
	want := []BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}, {Name: "API_TOKEN", Value: "${SYNTHETIC_TOKEN}"}}
	if _, err := store.AddOnce(Task{ID: "once", At: "2030-01-02 09:00", Content: "x", BashEnv: env}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddRecurring(Task{ID: "recur", Cron: "0 9 * * *", Content: "y", BashEnv: env}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddOnce(Task{ID: "bad", At: "2030-01-02 09:00", Content: "z", BashEnv: []BashEnvRef{{Name: "1BAD", Value: syntheticSecret}}}); err == nil {
		t.Fatal("an invalid bash_env name was added")
	} else if strings.Contains(err.Error(), syntheticSecret) {
		t.Fatalf("error shows the value: %v", err)
	}
	store = reloadStore(t, store)
	for _, id := range []string{"once", "recur"} {
		task, ok, err := store.FindByID(id)
		if err != nil || !ok || !reflect.DeepEqual(task.BashEnv, want) {
			t.Fatalf("%s bash_env = %+v, %v, %v", id, task.BashEnv, ok, err)
		}
	}
	if _, ok, _ := store.FindByID("bad"); ok {
		t.Fatal("the rejected task was stored")
	}
}

func TestStoreUpdateContentKeepsEverythingElse(t *testing.T) {
	for _, kind := range []string{"once", "recur"} {
		t.Run(kind, func(t *testing.T) {
			store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
			task := fullTask(kind)
			other := Task{ID: "other", Title: "Other", Cron: "*/5 * * * *", Content: "Ping"}
			if err := store.Write(File{Tasks: []Task{other, task}}); err != nil {
				t.Fatal(err)
			}
			if err := store.RecordRunStart(task.ID, time.Date(2026, 11, 1, 2, 3, 4, 0, time.UTC)); err != nil {
				t.Fatal(err)
			}
			if err := store.RecordRunResult(task.ID, RunStatusFailed); err != nil {
				t.Fatal(err)
			}
			before, _, _ := store.FindByID(task.ID)
			beforeMeta := readTaskRowMeta(t, store, task.ID)

			result, err := store.Update(context.Background(), task.ID, TaskPatch{Content: strPtr("Send the revised report")})
			if err != nil {
				t.Fatal(err)
			}
			if result.Action != "update" || result.TaskCount != 2 || !reflect.DeepEqual(result.Fields, []string{"content"}) {
				t.Fatalf("result = %+v", result)
			}

			store = reloadStore(t, store)
			after, ok, err := store.FindByID(task.ID)
			if err != nil || !ok {
				t.Fatalf("task after update: %v, %v", ok, err)
			}
			want := before
			want.Content = "Send the revised report"
			if !reflect.DeepEqual(after, want) {
				t.Fatalf("after update = %#v\nwant %#v", after, want)
			}
			if !reflect.DeepEqual(*result.Task, want) {
				t.Fatalf("result task = %#v\nwant %#v", *result.Task, want)
			}
			afterMeta := readTaskRowMeta(t, store, task.ID)
			if afterMeta.position != beforeMeta.position || afterMeta.createdAt != beforeMeta.createdAt {
				t.Fatalf("row meta = %+v, was %+v", afterMeta, beforeMeta)
			}
			if got, _, _ := store.FindByID("other"); !reflect.DeepEqual(got, Task{ID: "other", Title: "Other", Cron: "*/5 * * * *", Content: "Ping"}) {
				t.Fatalf("other task = %#v", got)
			}
		})
	}
}

func TestStoreUpdateSetsReplacesAndClearsBashEnv(t *testing.T) {
	for _, kind := range []string{"once", "recur"} {
		t.Run(kind, func(t *testing.T) {
			store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
			task := fullTask(kind)
			task.BashEnv = nil
			if err := store.Write(File{Tasks: []Task{task}}); err != nil {
				t.Fatal(err)
			}
			steps := []struct {
				name  string
				patch TaskPatch
				want  []BashEnvRef
			}{
				{"set", TaskPatch{BashEnv: envPtr(BashEnvRef{Name: "MODE", Value: "a"})}, []BashEnvRef{{Name: "MODE", Value: "a"}}},
				{"omit", TaskPatch{Title: strPtr("Renamed")}, []BashEnvRef{{Name: "MODE", Value: "a"}}},
				{"replace", TaskPatch{BashEnv: envPtr(BashEnvRef{Name: "TOKEN", Value: syntheticSecret}, BashEnvRef{Name: "MODE", Value: "b"})},
					[]BashEnvRef{{Name: "TOKEN", Value: syntheticSecret}, {Name: "MODE", Value: "b"}}},
				{"omit again", TaskPatch{Content: strPtr("New content")}, []BashEnvRef{{Name: "TOKEN", Value: syntheticSecret}, {Name: "MODE", Value: "b"}}},
				{"clear", TaskPatch{BashEnv: envPtr()}, nil},
			}
			for _, step := range steps {
				if _, err := store.Update(context.Background(), task.ID, step.patch); err != nil {
					t.Fatalf("%s: %v", step.name, err)
				}
				store = reloadStore(t, store)
				got, _, _ := store.FindByID(task.ID)
				if !reflect.DeepEqual(got.BashEnv, step.want) {
					t.Fatalf("%s: bash_env = %+v, want %+v", step.name, got.BashEnv, step.want)
				}
				if got.WorkspaceDir != task.WorkspaceDir || got.ChatID != task.ChatID || got.TZ != task.TZ || ScheduleForTask(got) != ScheduleForTask(task) {
					t.Fatalf("%s: other fields changed: %#v", step.name, got)
				}
			}
		})
	}
}

func TestStoreUpdateSwitchesScheduleKind(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	if err := store.Write(File{Tasks: []Task{fullTask("once")}}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Update(context.Background(), "report-once", TaskPatch{Cron: strPtr("0 8 * * *")}); err != nil {
		t.Fatal(err)
	}
	got, _, _ := store.FindByID("report-once")
	if got.At != "" || got.Cron != "0 8 * * *" || len(got.BashEnv) != 2 {
		t.Fatalf("to recurring = %#v", got)
	}
	if _, err := store.Update(context.Background(), "report-once", TaskPatch{At: strPtr("2031-05-06 07:08"), TZ: strPtr("")}); err != nil {
		t.Fatal(err)
	}
	got, _, _ = store.FindByID("report-once")
	if got.At != "2031-05-06 07:08" || got.Cron != "" || got.TZ != "" || len(got.BashEnv) != 2 {
		t.Fatalf("to one-time = %#v", got)
	}
	if _, err := store.Update(context.Background(), "report-once", TaskPatch{At: strPtr(""), Cron: strPtr("0 9 * * 1")}); err != nil {
		t.Fatal(err)
	}
	if got, _, _ = store.FindByID("report-once"); got.At != "" || got.Cron != "0 9 * * 1" {
		t.Fatalf("explicit switch = %#v", got)
	}
}

func TestStoreUpdateRejectsWithoutChangingTheTask(t *testing.T) {
	for _, kind := range []string{"once", "recur"} {
		t.Run(kind, func(t *testing.T) {
			store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
			task := fullTask(kind)
			if err := store.Write(File{Tasks: []Task{task}}); err != nil {
				t.Fatal(err)
			}
			before, _, _ := store.Read()
			beforeMeta := readTaskRowMeta(t, store, task.ID)
			cases := []struct {
				name  string
				id    string
				patch TaskPatch
			}{
				{"unknown id", "missing", TaskPatch{Content: strPtr("x")}},
				{"no id", "", TaskPatch{Content: strPtr("x")}},
				{"empty patch", task.ID, TaskPatch{}},
				{"invalid env name", task.ID, TaskPatch{Content: strPtr("x"), BashEnv: envPtr(BashEnvRef{Name: "1BAD", Value: syntheticSecret})}},
				{"empty env name", task.ID, TaskPatch{BashEnv: envPtr(BashEnvRef{Name: " ", Value: syntheticSecret})}},
				{"duplicate env name", task.ID, TaskPatch{BashEnv: envPtr(BashEnvRef{Name: "A", Value: syntheticSecret}, BashEnvRef{Name: "A", Value: "b"})}},
				{"invalid at", task.ID, TaskPatch{Content: strPtr("x"), At: strPtr("tomorrow")}},
				{"invalid cron", task.ID, TaskPatch{Content: strPtr("x"), Cron: strPtr("every day")}},
				{"both schedules", task.ID, TaskPatch{At: strPtr("2030-01-02 09:00"), Cron: strPtr("0 9 * * *")}},
				{"no schedule", task.ID, TaskPatch{At: strPtr(""), Cron: strPtr("")}},
				{"invalid tz", task.ID, TaskPatch{Content: strPtr("x"), TZ: strPtr("Mars/Base")}},
				{"empty content", task.ID, TaskPatch{Content: strPtr("  ")}},
				{"relative workspace", task.ID, TaskPatch{WorkspaceDir: strPtr("relative/dir")}},
			}
			for _, tc := range cases {
				_, err := store.Update(context.Background(), tc.id, tc.patch)
				if err == nil {
					t.Fatalf("%s: update accepted", tc.name)
				}
				if strings.Contains(err.Error(), syntheticSecret) {
					t.Fatalf("%s: error shows a bash_env value: %v", tc.name, err)
				}
				if tc.name == "unknown id" && !errors.Is(err, ErrTaskNotFound) {
					t.Fatalf("unknown id error = %v", err)
				}
				after, _, _ := reloadStore(t, store).Read()
				if !reflect.DeepEqual(after, before) {
					t.Fatalf("%s: list changed:\n%#v\nwas %#v", tc.name, after, before)
				}
				if meta := readTaskRowMeta(t, store, task.ID); meta != beforeMeta {
					t.Fatalf("%s: row rewritten: %+v, was %+v", tc.name, meta, beforeMeta)
				}
			}
		})
	}
}

// A cron.yaml from before agent.db is imported on first use; an update by id then keeps the
// bash_env and other settings the file had.
func TestStoreUpdateKeepsImportedCronYAMLSettings(t *testing.T) {
	dir := t.TempDir()
	raw := `version: 1
tasks:
  - id: weekly-report
    title: Weekly report
    cron: "0 10 * * 1"
    tz: UTC+8
    chat_id: "tg:-1001"
    workspace_dir: /srv/reports
    content: "Weekly report"
    bash_env:
      - REPORT_MODE: weekly
      - name: API_TOKEN
        value: "` + syntheticSecret + `"
  - id: standup
    at: "2030-01-02 09:00"
    content: "Standup"
    bash_env:
      - name: MODE
        value: once
`
	if err := os.WriteFile(filepath.Join(dir, "cron.yaml"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	for _, id := range []string{"weekly-report", "standup"} {
		if _, err := store.Update(context.Background(), id, TaskPatch{Content: strPtr("Edited " + id)}); err != nil {
			t.Fatalf("%s: %v", id, err)
		}
	}
	store = reloadStore(t, store)
	weekly, _, _ := store.FindByID("weekly-report")
	want := Task{ID: "weekly-report", Title: "Weekly report", Cron: "0 10 * * 1", TZ: "UTC+8", ChatID: "tg:-1001", WorkspaceDir: "/srv/reports",
		Content: "Edited weekly-report", BashEnv: []BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}, {Name: "API_TOKEN", Value: syntheticSecret}}}
	if !reflect.DeepEqual(weekly, want) {
		t.Fatalf("weekly = %#v\nwant %#v", weekly, want)
	}
	if _, err := os.Stat(filepath.Join(dir, "cron.yaml.imported")); err != nil {
		t.Fatalf("cron.yaml not imported: %v", err)
	}
	standup, _, _ := store.FindByID("standup")
	if standup.Content != "Edited standup" || standup.At != "2030-01-02 09:00" || !reflect.DeepEqual(standup.BashEnv, []BashEnvRef{{Name: "MODE", Value: "once"}}) {
		t.Fatalf("standup = %#v", standup)
	}
}
