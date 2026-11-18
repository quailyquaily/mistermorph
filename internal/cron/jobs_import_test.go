package cron

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
)

func TestNewJobIDIsJobUUIDv4(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		id := NewJobID()
		if !IsGeneratedJobID(id) {
			t.Fatalf("NewJobID() = %q, not job-<uuid v4>", id)
		}
		if seen[id] {
			t.Fatalf("NewJobID repeated %q", id)
		}
		seen[id] = true
	}
	for _, legacy := range []string{"cron-0b7e5d1c-2f7a-4c2e-9a51-1d2f3e4a5b6c", "task-3", "weekly-report", "job-123", "job-0B7E5D1C-2F7A-4C2E-9A51-1D2F3E4A5B6C"} {
		if IsGeneratedJobID(legacy) {
			t.Fatalf("IsGeneratedJobID(%q) = true", legacy)
		}
		if err := ValidateTask(Task{ID: legacy, Cron: "* * * * *", Content: "x"}); err != nil {
			t.Fatalf("legacy id %q no longer valid: %v", legacy, err)
		}
	}
	// A job added without an ID gets a generated one; one with an ID keeps it.
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	added, err := store.AddRecurring(Task{Cron: "* * * * *", Content: "x"})
	if err != nil || !IsGeneratedJobID(added.Task.ID) {
		t.Fatalf("added = %+v, %v", added.Task, err)
	}
	kept, err := store.AddOnce(Task{ID: "task-1", At: "2030-01-02 09:00", Content: "y"})
	if err != nil || kept.Task.ID != "task-1" {
		t.Fatalf("kept = %+v, %v", kept.Task, err)
	}
}

func jobIDs(tasks []Task) string {
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	return strings.Join(ids, ",")
}

func writeCronYAML(t *testing.T, dir, raw string) string {
	t.Helper()
	path := filepath.Join(dir, "cron.yaml")
	if err := os.WriteFile(path, []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestFirstRunWithNothingToImportIsAnEmptyStoreThatNeverReadsYAMLLater(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	tasks, err := store.Tasks(context.Background())
	if err != nil || tasks == nil || len(tasks) != 0 {
		t.Fatalf("tasks = %#v, %v", tasks, err)
	}
	if got, want := store.DBPath(), filepath.Join(dir, "agent.db"); got != want {
		t.Fatalf("DBPath = %q, want %q", got, want)
	}
	if _, err := os.Stat(filepath.Join(dir, "agent.db")); err != nil {
		t.Fatalf("agent.db not created: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, JobsDBFilename)); !os.IsNotExist(err) {
		t.Fatalf("a jobs.db was made: %v", err)
	}
	status, err := store.Import(context.Background())
	if err != nil || !status.Imported || status.Source != "" || status.Jobs != 0 {
		t.Fatalf("status = %+v, %v", status, err)
	}
	// A cron.yaml that shows up later (a downgrade writing its own) is not authoritative.
	writeCronYAML(t, dir, "version: 1\ntasks:\n  - id: late\n    cron: \"* * * * *\"\n    content: late\n")
	store = reloadStore(t, store)
	if tasks, err := store.Tasks(context.Background()); err != nil || len(tasks) != 0 {
		t.Fatalf("a later cron.yaml was imported: %+v, %v", tasks, err)
	}
}

const legacyYAML = `version: 1
tasks:
  - id: remind-standup
    title: Standup
    at: "2030-05-12 09:00"
    tz: Asia/Tokyo
    content: "Remind John"
    chat_id: "tg:-1001234567890"
  - id: weekly-report
    enabled: false
    cron: "0 10 * * 1"
    tz: UTC+8
    llm_profile: batch
    workspace_dir: /srv/reports
    mention: "@john"
    content: "Weekly report"
    bash_env:
      - REPORT_MODE: weekly
      - name: API_KEY
        value: "${OPENAI_API_KEY}"
  - id: task-3
    cron: "*/5 * * * *"
    content: "Ping"
`

func TestYAMLImportKeepsIDsOrderFieldsAndStateAndLeavesTheFileAlone(t *testing.T) {
	dir := t.TempDir()
	path := writeCronYAML(t, dir, legacyYAML)
	info, _ := os.Stat(path)
	store := NewStore(path)
	tasks, err := store.Tasks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	off := false
	want := []Task{
		{ID: "remind-standup", Title: "Standup", At: "2030-05-12 09:00", TZ: "Asia/Tokyo", Content: "Remind John", ChatID: "tg:-1001234567890"},
		{ID: "weekly-report", Title: DefaultTaskTitle, Enabled: &off, Cron: "0 10 * * 1", TZ: "UTC+8", LLMProfile: "batch",
			WorkspaceDir: "/srv/reports", Mention: "@john", Content: "Weekly report",
			BashEnv: []BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}, {Name: "API_KEY", Value: "${OPENAI_API_KEY}"}}},
		{ID: "task-3", Title: DefaultTaskTitle, Cron: "*/5 * * * *", Content: "Ping"},
	}
	if !reflect.DeepEqual(tasks, want) {
		t.Fatalf("tasks = %#v\nwant %#v", tasks, want)
	}
	status, err := store.Import(context.Background())
	if err != nil || status.Source != "cron.yaml" || status.Jobs != 3 {
		t.Fatalf("status = %+v, %v", status, err)
	}
	// The file is untouched: same content, same file, not renamed.
	if data, err := os.ReadFile(path); err != nil || string(data) != legacyYAML {
		t.Fatalf("cron.yaml changed: %q, %v", data, err)
	}
	if now, err := os.Stat(path); err != nil || !os.SameFile(now, info) || !now.ModTime().Equal(info.ModTime()) {
		t.Fatalf("cron.yaml replaced: %v", err)
	}
	if _, err := os.Stat(path + ".imported"); !os.IsNotExist(err) {
		t.Fatalf("cron.yaml.imported made: %v", err)
	}

	// Opening again imports nothing again, and a deleted job does not come back.
	if _, err := store.DeleteByID("weekly-report"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		store = reloadStore(t, store)
		tasks, err = store.Tasks(context.Background())
		if err != nil || jobIDs(tasks) != "remind-standup,task-3" {
			t.Fatalf("reopen %d: %s, %v", i, jobIDs(tasks), err)
		}
	}
}

func TestYAMLImportRejectsMissingDuplicateAndInvalidRecordsWholeAndRetries(t *testing.T) {
	dir := t.TempDir()
	path := writeCronYAML(t, dir, `version: 1
tasks:
  - id: good
    cron: "* * * * *"
    content: good
  - cron: "* * * * *"
    content: no id
  - id: good
    cron: "0 9 * * *"
    content: repeated id
  - id: no-schedule
    content: neither at nor cron
`)
	store := NewStore(path)
	_, _, err := store.Read()
	var importErr *ImportError
	if !errors.As(err, &importErr) {
		t.Fatalf("Read error = %v, want *ImportError", err)
	}
	want := []ImportReject{
		{Record: 2, Error: "task id is missing"},
		{Record: 3, ID: "good", Error: "duplicate task id"},
		{Record: 4, ID: "no-schedule", Error: "task no-schedule must use exactly one of at or cron"},
	}
	if !reflect.DeepEqual(importErr.Rejects, want) {
		t.Fatalf("rejects = %+v\nwant %+v", importErr.Rejects, want)
	}
	for _, part := range []string{"record 2: task id is missing", `record 3 (id "good"): duplicate task id`, "nothing was imported"} {
		if !strings.Contains(err.Error(), part) {
			t.Fatalf("error %q does not name %q", err, part)
		}
	}
	// Nothing was imported or marked: no partial list.
	assertNothingImported(t, dir)
	// The rest of agent.db is not held up by the job list's import.
	adb, err := agentdb.OpenStateDir(context.Background(), dir)
	if err != nil {
		t.Fatalf("agent.db does not open while the job import fails: %v", err)
	}
	if _, err := adb.Exec(`INSERT INTO workspace_attachments (scope_key, workspace_dir, updated_at) VALUES ('s', '/w', 'now')`); err != nil {
		t.Fatal(err)
	}
	_ = adb.Close()
	// Every operation reports it, the writes too.
	if _, err := store.AddRecurring(Task{Cron: "* * * * *", Content: "x"}); !errors.As(err, &importErr) {
		t.Fatalf("add during a failed import: %v", err)
	}

	// Fixed, the next open imports it.
	writeCronYAML(t, dir, "version: 1\ntasks:\n  - id: good\n    cron: \"* * * * *\"\n    content: good\n  - id: other\n    at: \"2030-01-01 10:00\"\n    content: other\n")
	tasks, err := store.Tasks(context.Background())
	if err != nil || jobIDs(tasks) != "good,other" {
		t.Fatalf("retry: %s, %v", jobIDs(tasks), err)
	}
}

func TestYAMLThatDoesNotParseImportsNothingAndRetries(t *testing.T) {
	dir := t.TempDir()
	writeCronYAML(t, dir, "version: 1\ntasks: [\n")
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	var importErr *ImportError
	if _, err := store.Tasks(context.Background()); !errors.As(err, &importErr) || importErr.Parse == "" {
		t.Fatalf("err = %v", err)
	}
	if err := os.Remove(filepath.Join(dir, "cron.yaml")); err != nil {
		t.Fatal(err)
	}
	if tasks, err := store.Tasks(context.Background()); err != nil || len(tasks) != 0 {
		t.Fatalf("after removing the file: %+v, %v", tasks, err)
	}
}

// legacyAgentDB makes the agent.db an earlier version kept the list in: cron_tasks rows, and the
// mark of its cron.yaml import when marked.
func legacyAgentDB(t *testing.T, dir string, marked bool, rows ...string) {
	t.Helper()
	db, err := agentdb.OpenStateDir(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	for _, row := range rows {
		if _, err := db.Exec(`INSERT INTO cron_tasks (id, position, title, enabled, at, cron, tz, content, chat_id, mention,
			llm_profile, workspace_dir, bash_env, created_at, updated_at, last_run_at, last_run_status) VALUES ` + row); err != nil {
			t.Fatal(err)
		}
	}
	if marked {
		if _, err := db.Exec(`INSERT INTO meta (key, value) VALUES ('imported:cron', '{"at":"2026-11-09T00:00:00Z","rename":["cron.yaml"]}')`); err != nil {
			t.Fatal(err)
		}
	}
}

func TestImportKeepsTheJobsAgentDBHeldAndIgnoresStaleYAML(t *testing.T) {
	dir := t.TempDir()
	legacyAgentDB(t, dir, true,
		`('b-second', 1, 'Second', 0, '', '0 9 * * *', 'UTC+8', 'second', 'tg:-1', '@amy', 'batch', '/w', '[{"name":"K","value":"v"}]', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', '2026-11-01T09:00:00Z', 'failed')`,
		`('a-first', 0, '', 1, '2030-01-01 10:00', '', '', 'first', '', '', '', '', '[]', '2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z', NULL, '')`,
	)
	// The cron.yaml of an older version is stale: agent.db imported it and has moved on since.
	stale := "version: 1\ntasks:\n  - id: deleted-long-ago\n    cron: \"* * * * *\"\n    content: gone\n"
	writeCronYAML(t, dir, stale)

	store := NewStore(filepath.Join(dir, "cron.yaml"))
	tasks, err := store.Tasks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	off := false
	want := []Task{
		{ID: "a-first", Title: DefaultTaskTitle, At: "2030-01-01 10:00", Content: "first"},
		{ID: "b-second", Title: "Second", Enabled: &off, Cron: "0 9 * * *", TZ: "UTC+8", Content: "second", ChatID: "tg:-1", Mention: "@amy",
			LLMProfile: "batch", WorkspaceDir: "/w", BashEnv: []BashEnvRef{{Name: "K", Value: "v"}},
			LastRunAt: "2026-11-01T09:00:00Z", LastRunStatus: RunStatusFailed},
	}
	if !reflect.DeepEqual(tasks, want) {
		t.Fatalf("tasks = %#v\nwant %#v", tasks, want)
	}
	meta := readTaskRowMeta(t, store, "b-second")
	if meta.createdAt != "2026-01-01T00:00:00Z" || meta.updatedAt != "2026-02-01T00:00:00Z" || meta.position != 1 {
		t.Fatalf("row meta = %+v", meta)
	}
	status, _ := store.Import(context.Background())
	if status.Source != "agent.db cron_tasks" || status.Jobs != 2 || !status.IgnoredYAML {
		t.Fatalf("status = %+v", status)
	}
	// cron_tasks itself is only read.
	adb, err := agentdb.OpenStateDir(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = adb.Close() }()
	var n int
	if err := adb.QueryRow(`SELECT count(*) FROM cron_tasks`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("agent.db rows = %d, %v", n, err)
	}
}

func TestImportPutsUnmarkedAgentDBJobsBeforeYAMLAndRejectsCollisions(t *testing.T) {
	dir := t.TempDir()
	legacyAgentDB(t, dir, false,
		`('db-job', 0, 'From db', 1, '', '0 9 * * *', '', 'db', '', '', '', '', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, '')`)
	writeCronYAML(t, dir, "version: 1\ntasks:\n  - id: db-job\n    cron: \"* * * * *\"\n    content: collides\n")
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	var importErr *ImportError
	if _, err := store.Tasks(context.Background()); !errors.As(err, &importErr) || len(importErr.Rejects) != 1 || importErr.Rejects[0].ID != "db-job" {
		t.Fatalf("err = %v", err)
	}
	writeCronYAML(t, dir, "version: 1\ntasks:\n  - id: yaml-job\n    cron: \"* * * * *\"\n    content: yaml\n")
	tasks, err := store.Tasks(context.Background())
	if err != nil || jobIDs(tasks) != "db-job,yaml-job" {
		t.Fatalf("tasks = %s, %v", jobIDs(tasks), err)
	}
	if status, _ := store.Import(context.Background()); status.Source != "agent.db cron_tasks+cron.yaml" || status.Jobs != 2 {
		t.Fatalf("status = %+v", status)
	}
}

func TestImportFailureMidwayRollsBackAndRetries(t *testing.T) {
	dir := t.TempDir()
	// The second row cannot go into jobs (an empty ID), after the first one has.
	legacyAgentDB(t, dir, true,
		`('ok', 0, '', 1, '', '* * * * *', '', 'ok', '', '', '', '', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, '')`,
		`('', 1, '', 1, '', '* * * * *', '', 'bad', '', '', '', '', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, '')`)
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	if _, err := store.Tasks(context.Background()); err == nil {
		t.Fatal("an import that failed midway reported success")
	}
	assertNothingImported(t, dir)
	adb, err := agentdb.OpenStateDir(context.Background(), dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := adb.Exec(`UPDATE cron_tasks SET id = 'fixed' WHERE id = ''`); err != nil {
		t.Fatal(err)
	}
	_ = adb.Close()
	tasks, err := store.Tasks(context.Background())
	if err != nil || jobIDs(tasks) != "ok,fixed" {
		t.Fatalf("retry: %s, %v", jobIDs(tasks), err)
	}
}

// openRawAgentDB opens agent.db with a pool of its own and none of the stores' code, as another
// process would.
func openRawAgentDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?_pragma=busy_timeout(10000)&_pragma=journal_mode(WAL)&_txlock=immediate")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

// assertNothingImported checks that agent.db in dir holds no jobs and no import mark.
func assertNothingImported(t *testing.T, dir string) {
	t.Helper()
	db := openRawAgentDB(t, filepath.Join(dir, "agent.db"))
	var jobs, marks int
	if err := db.QueryRow(`SELECT count(*) FROM jobs`).Scan(&jobs); err != nil || jobs != 0 {
		t.Fatalf("jobs = %d, %v", jobs, err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM meta WHERE key IN ('imported:jobs', 'jobs_import', 'jobs_revision')`).Scan(&marks); err != nil || marks != 0 {
		t.Fatalf("marks = %d, %v", marks, err)
	}
}

func TestConcurrentWritersKeepEveryJobAndAnotherProcessSeesThem(t *testing.T) {
	dir := t.TempDir()
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	var wg sync.WaitGroup
	errs := make(chan error, 40)
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			// Separate Store values share the database, as the scheduler, Console and tools do.
			s := NewStore(filepath.Join(dir, "cron.yaml"))
			_, err := s.AddRecurring(Task{Title: fmt.Sprintf("job %d", i), Cron: "* * * * *", Content: "x"})
			errs <- err
		}(i)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	tasks, err := store.Tasks(context.Background())
	if err != nil || len(tasks) != 40 {
		t.Fatalf("tasks = %d, %v", len(tasks), err)
	}
	// Another process's committed change shows on the next read.
	other := openRawAgentDB(t, filepath.Join(dir, "agent.db"))
	if _, err := other.Exec(`UPDATE jobs SET content = 'from elsewhere' WHERE id = ?`, tasks[0].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := other.Exec(`DELETE FROM jobs WHERE id = ?`, tasks[1].ID); err != nil {
		t.Fatal(err)
	}
	got, ok, err := store.FindByID(tasks[0].ID)
	if err != nil || !ok || got.Content != "from elsewhere" {
		t.Fatalf("FindByID = %+v, %v, %v", got, ok, err)
	}
	if _, ok, _ := store.FindByID(tasks[1].ID); ok {
		t.Fatal("a job another process deleted is still listed")
	}
}

func TestWriteAtRevisionRefusesAStaleList(t *testing.T) {
	ctx := context.Background()
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	if _, err := store.AddRecurring(Task{ID: "a", Cron: "* * * * *", Content: "a"}); err != nil {
		t.Fatal(err)
	}
	tasks, revision, err := store.Snapshot(ctx)
	if err != nil || len(tasks) != 1 || revision != 1 {
		t.Fatalf("snapshot = %+v, %d, %v", tasks, revision, err)
	}
	// Recording a run is not a change to the list.
	if err := store.RecordRunStart("a", time.Now()); err != nil {
		t.Fatal(err)
	}
	if rev, _ := store.Revision(ctx); rev != revision {
		t.Fatalf("revision moved with a run: %d", rev)
	}
	// A tool adds a job meanwhile; the Console's save of what it read would drop it.
	if _, err := NewStore(store.Path).AddRecurring(Task{ID: "b", Cron: "* * * * *", Content: "b"}); err != nil {
		t.Fatal(err)
	}
	tasks[0].Content = "edited"
	if _, err := store.WriteAtRevision(ctx, File{Tasks: tasks}, revision); !errors.Is(err, ErrRevisionConflict) {
		t.Fatalf("stale write: %v", err)
	}
	if got, _ := store.Tasks(ctx); jobIDs(got) != "a,b" || got[0].Content != "a" {
		t.Fatalf("list after a refused write = %+v", got)
	}
	current, _ := store.Revision(ctx)
	next, err := store.WriteAtRevision(ctx, File{Tasks: tasks}, current)
	if err != nil || next != current+1 {
		t.Fatalf("write = %d, %v", next, err)
	}
}

// Each execution of a job has its own run ID, apart from the job's ID, and a job's ID does not
// change with its runs.
func TestRepeatedRunsOfAJobHaveSeparateRunIDs(t *testing.T) {
	var board RunBoard
	jobID := NewJobID()
	seen := map[string]bool{}
	for i := 0; i < 3; i++ {
		runID := board.Queue(jobID, i == 0, time.Now())
		if runID == "" || runID == jobID || strings.HasPrefix(runID, JobIDPrefix) || seen[runID] {
			t.Fatalf("run %d id = %q (job %q, seen %v)", i, runID, jobID, seen)
		}
		seen[runID] = true
		if !board.Start(jobID, runID, time.Now(), func(error) {}) {
			t.Fatalf("run %d did not start", i)
		}
		board.Finish(jobID, runID, RunStatusDone, time.Now())
	}
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	if _, err := store.AddRecurring(Task{ID: jobID, Cron: "* * * * *", Content: "x"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := store.RecordRunStart(jobID, time.Now()); err != nil {
			t.Fatal(err)
		}
		if err := store.RecordRunResult(jobID, RunStatusDone); err != nil {
			t.Fatal(err)
		}
	}
	if tasks, _ := store.Tasks(context.Background()); len(tasks) != 1 || tasks[0].ID != jobID {
		t.Fatalf("job after runs = %+v", tasks)
	}
}

// An agent.db of a version before the jobs table (schema 5, the list in cron_tasks) keeps every
// other table and row when this version migrates it, and its list moves into jobs.
func TestUpgradeFromAnAgentDBBeforeTheJobsTableKeepsItsState(t *testing.T) {
	dir := t.TempDir()
	legacyAgentDB(t, dir, true,
		`('kept', 0, 'Kept', 0, '', '0 9 * * *', '', 'kept', '', '', '', '', '[]', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', NULL, '')`)
	path := filepath.Join(dir, "agent.db")
	raw := openRawAgentDB(t, path)
	for _, stmt := range []string{
		`INSERT INTO settings (path, kind, value, updated_at) VALUES ('llm.model', 'string', '"gpt-x"', '2026-01-01T00:00:00Z')`,
		`INSERT INTO heartbeat_workflows (id, position, title, instructions, created_at, updated_at) VALUES ('hb', 0, 'HB', 'check', 'a', 'b')`,
		`INSERT INTO topic_contexts (conversation_key, topic_id, updated_at) VALUES ('console:t1', 't1', 'now')`,
		`INSERT INTO meta (key, value) VALUES ('import_rejects:persona', '{"count":1,"rejects":[]}')`,
		// What a version before the jobs table left: no jobs table, schema 5.
		`DROP TABLE jobs`,
		`PRAGMA user_version = 5`,
	} {
		if _, err := raw.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	_ = raw.Close()

	store := NewStore(filepath.Join(dir, "cron.yaml"))
	tasks, err := store.Tasks(context.Background())
	if err != nil || jobIDs(tasks) != "kept" || TaskEnabled(tasks[0]) {
		t.Fatalf("tasks = %+v, %v", tasks, err)
	}
	check := openRawAgentDB(t, path)
	var version int
	if err := check.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != 6 {
		t.Fatalf("user_version = %d, %v", version, err)
	}
	for query, want := range map[string]int{
		`SELECT count(*) FROM settings WHERE path = 'llm.model' AND value = '"gpt-x"'`: 1,
		`SELECT count(*) FROM heartbeat_workflows WHERE id = 'hb'`:                     1,
		`SELECT count(*) FROM topic_contexts WHERE topic_id = 't1'`:                    1,
		`SELECT count(*) FROM meta WHERE key = 'import_rejects:persona'`:               1,
		`SELECT count(*) FROM meta WHERE key = 'imported:cron'`:                        1,
		`SELECT count(*) FROM cron_tasks WHERE id = 'kept'`:                            1,
		`SELECT count(*) FROM jobs WHERE id = 'kept' AND enabled = 0`:                  1,
	} {
		var got int
		if err := check.QueryRow(query).Scan(&got); err != nil || got != want {
			t.Fatalf("%s = %d, %v; want %d", query, got, err, want)
		}
	}
}

// makeLegacyJobsDB makes the jobs.db an earlier build kept the list in, with its import mark at
// markAt (none when ""). It returns the file's path.
func makeLegacyJobsDB(t *testing.T, dir, markAt string, rows ...string) string {
	t.Helper()
	path := filepath.Join(dir, JobsDBFilename)
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	stmts := []string{
		`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE jobs (id TEXT PRIMARY KEY, position INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '',
			enabled INTEGER NOT NULL DEFAULT 1, at TEXT NOT NULL DEFAULT '', cron TEXT NOT NULL DEFAULT '', tz TEXT NOT NULL DEFAULT '',
			content TEXT NOT NULL, chat_id TEXT NOT NULL DEFAULT '', mention TEXT NOT NULL DEFAULT '', llm_profile TEXT NOT NULL DEFAULT '',
			workspace_dir TEXT NOT NULL DEFAULT '', bash_env TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			last_run_at TEXT, last_run_status TEXT NOT NULL DEFAULT '')`,
		`PRAGMA user_version = 1`,
		`INSERT INTO meta (key, value) VALUES ('jobs_revision', '7')`,
	}
	if markAt != "" {
		stmts = append(stmts, `INSERT INTO meta (key, value) VALUES ('imported:jobs', '{"at":"`+markAt+`","source":"agent.db","jobs":3}')`)
	}
	for _, row := range rows {
		stmts = append(stmts, `INSERT INTO jobs (id, position, title, enabled, at, cron, tz, content, chat_id, mention,
			llm_profile, workspace_dir, bash_env, created_at, updated_at, last_run_at, last_run_status) VALUES `+row)
	}
	for _, stmt := range stmts {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	return path
}

func fileBytes(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestImportTakesAJobsDBOfAnEarlierBuildWholeAndLeavesItAlone(t *testing.T) {
	dir := t.TempDir()
	jobsPath := makeLegacyJobsDB(t, dir, "2026-11-18T12:00:00Z",
		`('job-b', 1, 'B', 0, '', '0 9 * * *', 'UTC+8', 'b', 'tg:-1', '@amy', 'batch', '/w', '[{"name":"K","value":"v"}]', '2026-01-01T00:00:00Z', '2026-11-18T12:30:00Z', '2026-11-18T09:00:00Z', 'done')`,
		`('task-2', 0, '', 1, '2030-01-01 10:00', '', '', 'a', '', '', '', '', '[]', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', NULL, '')`,
		`('cron-z', 2, 'Z', 1, '', '*/5 * * * *', '', 'z', '', '', '', '', '[]', '2026-11-18T13:00:00Z', '2026-11-18T13:00:00Z', NULL, '')`)
	before := fileBytes(t, jobsPath)
	// cron.yaml is stale: jobs.db took the list over.
	writeCronYAML(t, dir, "version: 1\ntasks:\n  - id: yaml-only\n    cron: \"* * * * *\"\n    content: stale\n")

	store := NewStore(filepath.Join(dir, "cron.yaml"))
	tasks, err := store.Tasks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	off := false
	want := []Task{
		{ID: "task-2", Title: DefaultTaskTitle, At: "2030-01-01 10:00", Content: "a"},
		{ID: "job-b", Title: "B", Enabled: &off, Cron: "0 9 * * *", TZ: "UTC+8", Content: "b", ChatID: "tg:-1", Mention: "@amy",
			LLMProfile: "batch", WorkspaceDir: "/w", BashEnv: []BashEnvRef{{Name: "K", Value: "v"}},
			LastRunAt: "2026-11-18T09:00:00Z", LastRunStatus: RunStatusDone},
		{ID: "cron-z", Title: "Z", Cron: "*/5 * * * *", Content: "z"},
	}
	if !reflect.DeepEqual(tasks, want) {
		t.Fatalf("tasks = %#v\nwant %#v", tasks, want)
	}
	if meta := readTaskRowMeta(t, store, "job-b"); meta.createdAt != "2026-01-01T00:00:00Z" || meta.updatedAt != "2026-11-18T12:30:00Z" || meta.position != 1 {
		t.Fatalf("row meta = %+v", meta)
	}
	status, err := store.Import(context.Background())
	if err != nil || status.Source != "jobs.db" || status.Jobs != 3 || !status.IgnoredYAML || len(status.Rejects) != 0 {
		t.Fatalf("status = %+v, %v", status, err)
	}
	if rev, err := store.Revision(context.Background()); err != nil || rev != 1 {
		t.Fatalf("revision = %d, %v", rev, err)
	}
	if fileBytes(t, jobsPath) != before {
		t.Fatal("jobs.db was changed by the import")
	}
	// Once only: a job deleted here does not come back from jobs.db.
	if _, err := store.DeleteByID("job-b"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		store = reloadStore(t, store)
		if tasks, err := store.Tasks(context.Background()); err != nil || jobIDs(tasks) != "task-2,cron-z" {
			t.Fatalf("reopen %d: %s, %v", i, jobIDs(tasks), err)
		}
	}
	if fileBytes(t, jobsPath) != before {
		t.Fatal("jobs.db was changed")
	}
}

// Beside a jobs.db, agent.db's cron_tasks adds only what jobs.db cannot already have; what cannot
// be reconciled is rejected and listed, and jobs.db's version stands.
func TestImportMergesJobsDBAndCronTasksByTheDocumentedRules(t *testing.T) {
	dir := t.TempDir()
	const before, after = "2026-11-18T11:00:00Z", "2026-11-18T13:00:00Z"
	row := func(id string, position int, content, created, updated string) string {
		return fmt.Sprintf(`('%s', %d, '', 1, '', '0 9 * * *', '', '%s', '', '', '', '', '[]', '%s', '%s', NULL, '')`, id, position, content, created, updated)
	}
	jobsPath := makeLegacyJobsDB(t, dir, "2026-11-18T12:00:00Z",
		`('same', 0, '', 1, '', '0 9 * * *', '', 'same', '', '', '', '', '[]', '`+before+`', '`+after+`', '2026-11-18T12:30:00Z', 'done')`,
		row("edited", 1, "edited in jobs.db", before, after),
		row("both", 2, "jobs.db version", before, after),
		row("newer-clash", 3, "jobs.db version", after, after),
		row("only-jobs", 4, "only in jobs.db", after, after))
	jobsBefore := fileBytes(t, jobsPath)
	legacyAgentDB(t, dir, true,
		row("same", 0, "same", before, after),
		row("edited", 1, "original", before, before),
		row("gone", 2, "deleted in jobs.db", before, before),
		row("gone-changed", 3, "changed after jobs.db deleted it", before, after),
		row("both", 4, "agent.db version", before, after),
		row("newer-clash", 5, "agent.db version", after, after),
		row("added-later", 6, "added by an older version", after, after))
	writeCronYAML(t, dir, legacyYAML)

	store := NewStore(filepath.Join(dir, "cron.yaml"))
	tasks, err := store.Tasks(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if got := jobIDs(tasks); got != "same,edited,both,newer-clash,only-jobs,added-later" {
		t.Fatalf("ids = %s", got)
	}
	contents := map[string]string{}
	for _, task := range tasks {
		contents[task.ID] = task.Content
	}
	for id, want := range map[string]string{"edited": "edited in jobs.db", "both": "jobs.db version", "newer-clash": "jobs.db version",
		"added-later": "added by an older version"} {
		if contents[id] != want {
			t.Fatalf("%s content = %q, want %q", id, contents[id], want)
		}
	}
	if tasks[0].LastRunStatus != RunStatusDone {
		t.Fatalf("jobs.db's run of the same job was lost: %+v", tasks[0])
	}
	status, err := store.Import(context.Background())
	if err != nil || status.Source != "jobs.db+agent.db cron_tasks" || status.Jobs != 6 || !status.IgnoredYAML {
		t.Fatalf("status = %+v, %v", status, err)
	}
	if len(status.Rejects) != 3 {
		t.Fatalf("rejects = %+v", status.Rejects)
	}
	for i, want := range []struct {
		line int
		id   string
		says string
	}{{4, "gone-changed", "not brought back"}, {5, "both", "jobs.db's version is kept"}, {6, "newer-clash", "jobs.db's version is kept"}} {
		got := status.Rejects[i]
		if got.Source != "agent.db cron_tasks" || got.Line != want.line || !strings.Contains(got.Error, want.id) ||
			!strings.Contains(got.Error, want.says) || !strings.Contains(got.Raw, "id: "+want.id) {
			t.Fatalf("reject %d = %+v, want %+v", i, got, want)
		}
	}
	// Both databases it read are as they were.
	if fileBytes(t, jobsPath) != jobsBefore {
		t.Fatal("jobs.db was changed")
	}
	raw := openRawAgentDB(t, filepath.Join(dir, "agent.db"))
	var n int
	if err := raw.QueryRow(`SELECT count(*) FROM cron_tasks`).Scan(&n); err != nil || n != 7 {
		t.Fatalf("cron_tasks rows = %d, %v", n, err)
	}
	// Opening again imports nothing again.
	store = reloadStore(t, store)
	if tasks, err := store.Tasks(context.Background()); err != nil || len(tasks) != 6 {
		t.Fatalf("reopen: %s, %v", jobIDs(tasks), err)
	}
}

// A jobs.db whose own import never finished (no mark, no jobs) took nothing over: cron.yaml is
// still the list to import.
func TestAJobsDBThatNeverTookTheListOverLeavesCronYAMLToImport(t *testing.T) {
	dir := t.TempDir()
	makeLegacyJobsDB(t, dir, "")
	writeCronYAML(t, dir, legacyYAML)
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	tasks, err := store.Tasks(context.Background())
	if err != nil || jobIDs(tasks) != "remind-standup,weekly-report,task-3" {
		t.Fatalf("tasks = %s, %v", jobIDs(tasks), err)
	}
	if status, _ := store.Import(context.Background()); status.Source != "jobs.db+cron.yaml" || status.Jobs != 3 {
		t.Fatalf("status = %+v", status)
	}
}

// A jobs.db that cannot be read stops the import (nothing is imported) rather than leave its
// jobs behind; moved aside, the next open imports without it.
func TestAJobsDBThatCannotBeReadFailsTheImportAndRetries(t *testing.T) {
	dir := t.TempDir()
	jobsPath := filepath.Join(dir, JobsDBFilename)
	if err := os.WriteFile(jobsPath, []byte("not a database, but long enough to be read as one................................................................"), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyAgentDB(t, dir, true,
		`('a', 0, '', 1, '', '* * * * *', '', 'a', '', '', '', '', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL, '')`)
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	if _, err := store.Tasks(context.Background()); err == nil || !strings.Contains(err.Error(), "jobs.db") {
		t.Fatalf("err = %v", err)
	}
	assertNothingImported(t, dir)
	if err := os.Rename(jobsPath, jobsPath+".broken"); err != nil {
		t.Fatal(err)
	}
	if tasks, err := store.Tasks(context.Background()); err != nil || jobIDs(tasks) != "a" {
		t.Fatalf("retry: %s, %v", jobIDs(tasks), err)
	}
}

// The jobs.db of an earlier build is in WAL mode, and that build may still be running: the import
// reads the commits still in its -wal, and writes neither the database nor its -wal (only the
// -shm index, whose read marks every reader of a WAL database takes).
func TestImportReadsALiveWALJobsDBWithoutWritingIt(t *testing.T) {
	dir := t.TempDir()
	jobsPath := filepath.Join(dir, JobsDBFilename)
	writer, err := sql.Open("sqlite", "file:"+filepath.ToSlash(jobsPath)+"?_pragma=journal_mode(WAL)&_pragma=wal_autocheckpoint(0)")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Close() }()
	writer.SetMaxOpenConns(1)
	for _, stmt := range []string{
		`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
		`CREATE TABLE jobs (id TEXT PRIMARY KEY, position INTEGER NOT NULL, title TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
			at TEXT NOT NULL DEFAULT '', cron TEXT NOT NULL DEFAULT '', tz TEXT NOT NULL DEFAULT '', content TEXT NOT NULL,
			chat_id TEXT NOT NULL DEFAULT '', mention TEXT NOT NULL DEFAULT '', llm_profile TEXT NOT NULL DEFAULT '',
			workspace_dir TEXT NOT NULL DEFAULT '', bash_env TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
			last_run_at TEXT, last_run_status TEXT NOT NULL DEFAULT '')`,
		`INSERT INTO meta (key, value) VALUES ('imported:jobs', '{"at":"2026-11-18T12:00:00Z"}')`,
		`INSERT INTO jobs (id, position, cron, content, created_at, updated_at) VALUES ('in-wal', 0, '* * * * *', 'only in the wal', '2026-11-18T12:00:00Z', '2026-11-18T12:00:00Z')`,
	} {
		if _, err := writer.Exec(stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	if info, err := os.Stat(jobsPath + "-wal"); err != nil || info.Size() == 0 {
		t.Fatalf("no -wal: %v", err)
	}
	snapshot := func() map[string]string {
		out := map[string]string{}
		for _, suffix := range []string{"", "-wal"} {
			if data, err := os.ReadFile(jobsPath + suffix); err == nil {
				out[suffix] = string(data)
			}
		}
		return out
	}
	before := snapshot()
	store := NewStore(filepath.Join(dir, "cron.yaml"))
	tasks, err := store.Tasks(context.Background())
	if err != nil || jobIDs(tasks) != "in-wal" || tasks[0].Content != "only in the wal" {
		t.Fatalf("tasks = %+v, %v", tasks, err)
	}
	after := snapshot()
	for suffix := range before {
		if after[suffix] != before[suffix] {
			t.Fatalf("the import wrote jobs.db%s (%d -> %d bytes)", suffix, len(before[suffix]), len(after[suffix]))
		}
	}
}
