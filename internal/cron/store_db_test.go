package cron

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/assets"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

func TestStoreRoundTripsEveryFieldInOrder(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	off := false
	tasks := []Task{
		{ID: "b-recur", Title: "Weekly", Enabled: &off, Cron: "0 10 * * 1", TZ: "UTC+8", Content: "Check the report",
			ChatID: "tg:-100", Mention: "@john", LLMProfile: "batch", WorkspaceDir: "/srv/reports",
			BashEnv: []BashEnvRef{{Name: "MODE", Value: "weekly"}, {Name: "API_KEY", Value: "${OPENAI_API_KEY}"}}},
		{ID: "a-once", At: "2030-01-02 09:00", TZ: "Asia/Tokyo", Content: "Standup"},
		{ID: "c-plain", Cron: "*/5 * * * *", Content: "Ping"},
	}
	if err := store.Write(File{Version: Version, Tasks: tasks}); err != nil {
		t.Fatal(err)
	}
	file, exists, err := store.Read()
	if err != nil || !exists {
		t.Fatalf("Read: %v, %v", exists, err)
	}
	want := append([]Task(nil), tasks...)
	want[1].Title = DefaultTaskTitle
	want[2].Title = DefaultTaskTitle
	if !reflect.DeepEqual(file.Tasks, want) {
		t.Fatalf("tasks = %#v\nwant %#v", file.Tasks, want)
	}
	// Replacing the list keeps the new order (the Console's PUT /todo/tasks).
	reordered := []Task{file.Tasks[2], file.Tasks[0], file.Tasks[1]}
	if err := store.Write(File{Tasks: reordered}); err != nil {
		t.Fatal(err)
	}
	file, _, _ = store.Read()
	ids := []string{}
	for _, task := range file.Tasks {
		ids = append(ids, task.ID)
	}
	if strings.Join(ids, ",") != "c-plain,b-recur,a-once" {
		t.Fatalf("order = %v", ids)
	}
	// No file is written.
	if _, err := os.Stat(filepath.Join(dir, "cron.yaml")); !os.IsNotExist(err) {
		t.Fatalf("cron.yaml written: %v", err)
	}
}

func TestStoreRejectsAnInvalidListWhole(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	if err := store.Write(File{Tasks: []Task{{ID: "ok", Cron: "* * * * *", Content: "x"}}}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []Task{
		{ID: "both", At: "2030-01-02 09:00", Cron: "* * * * *", Content: "x"},
		{ID: "neither", Content: "x"},
		{ID: "ok", Cron: "* * * * *", Content: "dupe"},
	} {
		if err := store.Write(File{Tasks: []Task{{ID: "ok", Cron: "* * * * *", Content: "x"}, bad}}); err == nil {
			t.Fatalf("invalid task %s saved", bad.ID)
		}
	}
	file, _, _ := store.Read()
	if len(file.Tasks) != 1 || file.Tasks[0].ID != "ok" {
		t.Fatalf("list changed by a rejected write: %+v", file.Tasks)
	}
	// The table's own check refuses a row with both or neither schedule.
	db, err := agentdb.Cached(filepath.Join(filepath.Dir(store.Path), "agent.db")).Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO cron_tasks (id, position, content, at, cron, created_at, updated_at) VALUES ('x', 9, 'c', '', '', 'now', 'now')`); err == nil {
		t.Fatal("a row without at or cron was stored")
	}
}

func TestImportCronYAMLKeepsOrderAndListsRejects(t *testing.T) {
	dir := t.TempDir()
	raw := `version: 1
tasks:
  - id: remind-standup
    at: "2026-05-12 09:00"
    tz: Asia/Tokyo
    content: "Remind John"
    chat_id: "tg:-1001234567890"
  - id: broken
    content: "No schedule"
  - id: weekly-report
    cron: "0 10 * * 1"
    tz: UTC+8
    llm_profile: batch
    content: "Weekly report"
    bash_env:
      - REPORT_MODE: weekly
      - name: API_KEY
        value: "${OPENAI_API_KEY}"
`
	if err := os.WriteFile(filepath.Join(dir, "cron.yaml"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	file, _, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(file.Tasks) != 2 || file.Tasks[0].ID != "remind-standup" || file.Tasks[1].ID != "weekly-report" {
		t.Fatalf("tasks = %+v", file.Tasks)
	}
	if got := file.Tasks[1].BashEnv; len(got) != 2 || got[0] != (BashEnvRef{Name: "REPORT_MODE", Value: "weekly"}) || got[1].Value != "${OPENAI_API_KEY}" {
		t.Fatalf("bash_env = %+v", got)
	}
	db, err := agentdb.Cached(filepath.Join(dir, "agent.db")).Get(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	rejects, err := agentdb.Rejects(context.Background(), db, "cron")
	if err != nil || rejects.Count != 1 || rejects.Rejects[0].Line != 2 || !strings.Contains(rejects.Rejects[0].Error, "exactly one of at or cron") {
		t.Fatalf("rejects = %+v, %v", rejects, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "cron.yaml.imported")); err != nil {
		t.Fatalf("cron.yaml not renamed: %v", err)
	}
}

func TestImportCronTemplateIsAnEmptyList(t *testing.T) {
	dir := t.TempDir()
	tmpl, err := assets.ConfigFS.ReadFile("config/cron.yaml")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "cron.yaml"), tmpl, 0o600); err != nil {
		t.Fatal(err)
	}
	file, _, err := NewStore(filepath.Join(dir, "cron.yaml")).Read()
	if err != nil || len(file.Tasks) != 0 {
		t.Fatalf("template = %+v, %v", file.Tasks, err)
	}
}

func TestStoreRecordsTheLastRunAndKeepsItThroughWrites(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	if _, err := store.AddRecurring(Task{ID: "t1", Cron: "* * * * *", Content: "x"}); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2026, 11, 9, 1, 2, 3, 0, time.UTC)
	if err := store.RecordRunStart("t1", at); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordRunResult("t1", RunStatusFailed); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordRunStart(HeartbeatTaskID, at); err != nil {
		t.Fatalf("a task that is not stored: %v", err)
	}
	task, ok, err := store.FindByID("t1")
	if err != nil || !ok || task.LastRunAt != "2026-11-09T01:02:03Z" || task.LastRunStatus != RunStatusFailed {
		t.Fatalf("task = %+v, %v, %v", task, ok, err)
	}
	// A list saved from the Console (which does not send the run) keeps it.
	task.LastRunAt, task.LastRunStatus = "", ""
	task.Content = "changed"
	if err := store.Write(File{Tasks: []Task{task}}); err != nil {
		t.Fatal(err)
	}
	task, _, _ = store.FindByID("t1")
	if task.Content != "changed" || task.LastRunStatus != RunStatusFailed || task.LastRunAt == "" {
		t.Fatalf("after write = %+v", task)
	}
	rendered, err := RenderFile(File{Tasks: []Task{task}})
	if err != nil || strings.Contains(rendered, "last_run") {
		t.Fatalf("cron.yaml text shows the run: %q, %v", rendered, err)
	}
}

func TestRenderAndParseFileRoundTrip(t *testing.T) {
	file := File{Version: Version, Tasks: []Task{{ID: "a", Title: "A", Cron: "0 9 * * *", Content: "x", BashEnv: []BashEnvRef{{Name: "K", Value: "v"}}}}}
	text, err := RenderFile(file)
	if err != nil {
		t.Fatal(err)
	}
	parsed, err := ParseFile(text)
	if err != nil || !reflect.DeepEqual(parsed, file) {
		t.Fatalf("parsed = %#v, %v", parsed, err)
	}
	if _, err := ParseFile("version: 2\ntasks: []\n"); err == nil {
		t.Fatal("unknown version parsed")
	}
}

func TestSchedulerLockIsAFileInTheLocksFolderAndExclusive(t *testing.T) {
	dir := t.TempDir()
	path, err := SchedulerLockPath(filepath.Join(dir, "cron.yaml"))
	if err != nil || path != filepath.Join(dir, "locks", "cron.scheduler.lck") {
		t.Fatalf("lock path = %q, %v", path, err)
	}
	release, err := fsstore.AcquireLock(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	if second, err := fsstore.AcquireLock(ctx, path); err == nil {
		second()
		t.Fatal("a second holder took the scheduler lock")
	}
	release()
	again, err := fsstore.AcquireLock(context.Background(), path)
	if err != nil {
		t.Fatalf("lock not released: %v", err)
	}
	again()
}
