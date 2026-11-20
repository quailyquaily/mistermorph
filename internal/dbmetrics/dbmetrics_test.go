package dbmetrics

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/domainjournal"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/memories"
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"github.com/quailyquaily/mistermorph/internal/statesnapshot"
)

// writeDB creates a database at path with one table per name, each holding the given rows.
func writeDB(t *testing.T, path string, tables map[string]int) {
	t.Helper()
	db, err := sqlitedb.Open(context.Background(), path, nil)
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	defer func() { _ = db.Close() }()
	for name, rows := range tables {
		if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS "` + name + `" (id INTEGER PRIMARY KEY, secret TEXT)`); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		for i := 0; i < rows; i++ {
			if _, err := db.Exec(`INSERT INTO "`+name+`" (secret) VALUES (?)`, "private-content"); err != nil {
				t.Fatalf("insert %s: %v", name, err)
			}
		}
	}
}

func byName(t *testing.T, items []Database, name string) Database {
	t.Helper()
	for _, item := range items {
		if item.Name == name {
			return item
		}
	}
	t.Fatalf("no database %q in %+v", name, items)
	return Database{}
}

func rowsOf(t *testing.T, item Database, table string) *int64 {
	t.Helper()
	for _, entry := range item.Tables {
		if entry.Name == table {
			return entry.Rows
		}
	}
	t.Fatalf("no table %q in %+v", table, item)
	return nil
}

func wantRows(t *testing.T, item Database, table string, want int64) {
	t.Helper()
	got := rowsOf(t, item, table)
	if got == nil {
		t.Fatalf("%s.%s rows unknown, want %d", item.File, table, want)
	}
	if *got != want {
		t.Fatalf("%s.%s rows = %d, want %d", item.File, table, *got, want)
	}
}

func TestSpecsCoverTheStateDatabases(t *testing.T) {
	specs := map[string]string{}
	for _, spec := range Specs {
		specs[spec.Name] = spec.Path
		if len(spec.Tables) == 0 {
			t.Fatalf("%s counts no table", spec.Name)
		}
	}
	for _, db := range statesnapshot.Databases {
		if specs[db.Name] != db.Path {
			t.Fatalf("database %s (%s) has no metrics spec: %v", db.Name, db.Path, specs)
		}
	}
	if len(specs) != len(statesnapshot.Databases) {
		t.Fatalf("specs %v do not match statesnapshot.Databases", specs)
	}
}

// The stores' own schemas have every counted table: a renamed table would otherwise read as
// unknown for ever. The stores stay open while counting, as they are in a running agent.
func TestCollectCountsTheRealStoresWhileTheyAreOpen(t *testing.T) {
	stateDir := t.TempDir()
	ctx := context.Background()

	agent, err := agentdb.OpenWithoutImports(ctx, filepath.Join(stateDir, statepaths.AgentDBFilename))
	if err != nil {
		t.Fatalf("agent.db: %v", err)
	}
	defer func() { _ = agent.Close() }()
	journal, err := domainjournal.New(domainjournal.JournalOptions{Dir: filepath.Join(stateDir, statepaths.JournalDirName)})
	if err != nil {
		t.Fatalf("journal.db: %v", err)
	}
	defer func() { _ = journal.Close() }()
	memory, err := memories.Open(ctx, filepath.Join(stateDir, statepaths.MemoryDBFilename))
	if err != nil {
		t.Fatalf("memory.db: %v", err)
	}
	defer func() { _ = memory.Close() }()
	usage, err := llmstats.OpenUsageStore(ctx, filepath.Join(stateDir, statepaths.UsageDBFilename), llmstats.UsageStoreOptions{})
	if err != nil {
		t.Fatalf("usage.db: %v", err)
	}
	defer func() { _ = usage.Close() }()

	items := New(stateDir).Collect(ctx)
	if len(items) != len(Specs) {
		t.Fatalf("got %d databases, want %d", len(items), len(Specs))
	}
	for i, spec := range Specs {
		item := items[i]
		if item.Name != spec.Name || item.File != filepath.Base(spec.Path) {
			t.Fatalf("item %d = %s/%s, want %s/%s", i, item.Name, item.File, spec.Name, filepath.Base(spec.Path))
		}
		if item.Status != StatusOK {
			t.Fatalf("%s status = %q, want ok", item.File, item.Status)
		}
		if item.SizeBytes == nil || *item.SizeBytes <= 0 {
			t.Fatalf("%s size = %v, want a positive size", item.File, item.SizeBytes)
		}
		for _, table := range spec.Tables {
			// Empty, and known to be: zero, not unknown.
			wantRows(t, item, table, 0)
		}
	}
}

func TestCollectReportsSizesAndCountsWithoutContentOrPaths(t *testing.T) {
	stateDir := t.TempDir()
	writeDB(t, filepath.Join(stateDir, "agent.db"), map[string]int{"contacts": 3, "jobs": 0, "topic_contexts": 12})
	writeDB(t, filepath.Join(stateDir, "journal", "journal.db"), map[string]int{"journal_events": 250})

	items := New(stateDir).Collect(context.Background())

	agent := byName(t, items, "agent")
	if agent.Status != StatusOK || agent.File != "agent.db" {
		t.Fatalf("agent = %+v", agent)
	}
	wantRows(t, agent, "contacts", 3)
	wantRows(t, agent, "jobs", 0)
	wantRows(t, agent, "topic_contexts", 12)
	info, err := os.Stat(filepath.Join(stateDir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	if agent.SizeBytes == nil || *agent.SizeBytes < info.Size() {
		t.Fatalf("agent size = %v, want at least the file's %d", agent.SizeBytes, info.Size())
	}
	journal := byName(t, items, "journal")
	if journal.File != "journal.db" {
		t.Fatalf("journal file = %q, want the base name", journal.File)
	}
	wantRows(t, journal, "journal_events", 250)

	raw, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	for _, leak := range []string{stateDir, "private-content", "secret"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("payload holds %q: %s", leak, raw)
		}
	}
}

func TestCollectMissingDatabasesAreMissingNotZeroAndAreNotCreated(t *testing.T) {
	stateDir := t.TempDir()
	items := New(stateDir).Collect(context.Background())
	if len(items) != len(Specs) {
		t.Fatalf("got %d databases, want %d", len(items), len(Specs))
	}
	for _, item := range items {
		if item.Status != StatusMissing {
			t.Fatalf("%s status = %q, want missing", item.File, item.Status)
		}
		if item.SizeBytes != nil {
			t.Fatalf("%s size = %d, want unknown", item.File, *item.SizeBytes)
		}
		for _, table := range item.Tables {
			if table.Rows != nil {
				t.Fatalf("%s.%s rows = %d, want unknown", item.File, table.Name, *table.Rows)
			}
		}
	}
	entries, err := os.ReadDir(stateDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Fatalf("collecting created %v in the state folder", entries)
	}
	raw, _ := json.Marshal(items)
	if !strings.Contains(string(raw), `"size_bytes":null`) || !strings.Contains(string(raw), `"rows":null`) {
		t.Fatalf("unknown values must be null in the payload: %s", raw)
	}
}

func TestCollectUnreadableDatabasesAreUnavailable(t *testing.T) {
	stateDir := t.TempDir()
	// Not a database: its size is known, its rows are not.
	if err := os.WriteFile(filepath.Join(stateDir, "agent.db"), []byte(strings.Repeat("not a database ", 64)), 0o600); err != nil {
		t.Fatal(err)
	}
	// A folder where the file should be.
	if err := os.MkdirAll(filepath.Join(stateDir, "memory.db"), 0o700); err != nil {
		t.Fatal(err)
	}
	// A database of an older schema: the table is not there yet.
	writeDB(t, filepath.Join(stateDir, "usage.db"), map[string]int{"something_else": 2})

	items := New(stateDir).Collect(context.Background())

	agent := byName(t, items, "agent")
	if agent.Status != StatusUnavailable || agent.SizeBytes == nil || *agent.SizeBytes != 15*64 {
		t.Fatalf("agent = %+v, want unavailable with its size", agent)
	}
	for _, table := range agent.Tables {
		if table.Rows != nil {
			t.Fatalf("agent.%s rows = %d, want unknown", table.Name, *table.Rows)
		}
	}
	memory := byName(t, items, "memory")
	if memory.Status != StatusUnavailable || memory.SizeBytes != nil {
		t.Fatalf("memory = %+v, want unavailable without a size", memory)
	}
	usage := byName(t, items, "usage")
	if usage.Status != StatusOK || usage.SizeBytes == nil {
		t.Fatalf("usage = %+v, want ok with a size", usage)
	}
	if rows := rowsOf(t, usage, "llm_requests"); rows != nil {
		t.Fatalf("usage.llm_requests rows = %d, want unknown", *rows)
	}
	if got := byName(t, items, "journal").Status; got != StatusMissing {
		t.Fatalf("journal status = %q, want missing", got)
	}
}

func TestCollectFileWithoutReadPermissionIsUnavailable(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads every file")
	}
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, "memory.db")
	writeDB(t, path, map[string]int{"memories": 4})
	if err := os.Chmod(path, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
	memory := byName(t, New(stateDir).Collect(context.Background()), "memory")
	if memory.Status != StatusUnavailable {
		t.Fatalf("memory = %+v, want unavailable", memory)
	}
	if rows := rowsOf(t, memory, "memories"); rows != nil {
		t.Fatalf("memories rows = %d, want unknown", *rows)
	}
}

func TestCollectKeepsCountsUntilTheFilesChangeAndTheIntervalPasses(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, "memory.db")
	writeDB(t, path, map[string]int{"memories": 2})

	collector := New(stateDir)
	now := time.Date(2026, 11, 20, 9, 0, 0, 0, time.UTC)
	collector.now = func() time.Time { return now }
	counts := 0
	collector.countHook = func(string) { counts++ }
	ctx := context.Background()

	wantRows(t, byName(t, collector.Collect(ctx), "memory"), "memories", 2)
	if counts != 1 {
		t.Fatalf("counted %d times, want 1", counts)
	}
	// Nothing changed: however long ago, no new count.
	now = now.Add(10 * time.Minute)
	wantRows(t, byName(t, collector.Collect(ctx), "memory"), "memories", 2)
	if counts != 1 {
		t.Fatalf("an unchanged database was counted again (%d)", counts)
	}

	// The count just taken stands for MinRecount, whatever is written meanwhile; the size follows at once.
	now = now.Add(time.Minute)
	writeDB(t, filepath.Join(stateDir, "usage.db"), map[string]int{"llm_requests": 1})
	wantRows(t, byName(t, collector.Collect(ctx), "usage"), "llm_requests", 1)
	countsBefore := counts
	writeDB(t, filepath.Join(stateDir, "usage.db"), map[string]int{"llm_requests": 4})
	now = now.Add(MinRecount - time.Second)
	wantRows(t, byName(t, collector.Collect(ctx), "usage"), "llm_requests", 1)
	if counts != countsBefore {
		t.Fatalf("counted again within MinRecount (%d, was %d)", counts, countsBefore)
	}
	now = now.Add(2 * time.Second)
	wantRows(t, byName(t, collector.Collect(ctx), "usage"), "llm_requests", 5)
	if counts != countsBefore+1 {
		t.Fatalf("counted %d times after the change, want one more than %d", counts, countsBefore)
	}

	// A deleted database is missing at once, not the last count.
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(path + suffix)
	}
	if got := byName(t, collector.Collect(ctx), "memory"); got.Status != StatusMissing || rowsOf(t, got, "memories") != nil {
		t.Fatalf("deleted memory.db = %+v, want missing", got)
	}
}

func TestCollectOutOfTimeLeavesCountsUnknownAndTriesAgain(t *testing.T) {
	stateDir := t.TempDir()
	writeDB(t, filepath.Join(stateDir, "memory.db"), map[string]int{"memories": 2})
	collector := New(stateDir)

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	memory := byName(t, collector.Collect(cancelled), "memory")
	if memory.Status != StatusOK || memory.SizeBytes == nil {
		t.Fatalf("memory = %+v, want its size", memory)
	}
	if rows := rowsOf(t, memory, "memories"); rows != nil {
		t.Fatalf("rows = %d, want unknown when out of time", *rows)
	}
	wantRows(t, byName(t, collector.Collect(context.Background()), "memory"), "memories", 2)
}

func TestCollectDoesNotWriteToTheDatabase(t *testing.T) {
	stateDir := t.TempDir()
	path := filepath.Join(stateDir, "memory.db")
	writeDB(t, path, map[string]int{"memories": 2})
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	New(stateDir).Collect(context.Background())
	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(before) != string(after) {
		t.Fatal("collecting changed the database file")
	}
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var rows int
	if err := db.QueryRow("SELECT COUNT(*) FROM memories").Scan(&rows); err != nil || rows != 2 {
		t.Fatalf("rows = %d, err = %v", rows, err)
	}
}

func TestNilCollector(t *testing.T) {
	if New("  ") != nil {
		t.Fatal("no state folder must give no collector")
	}
	var collector *Collector
	if got := collector.Collect(context.Background()); got != nil {
		t.Fatalf("nil collector = %+v", got)
	}
}
