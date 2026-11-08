package agentdb

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
)

// testImporter imports lines of notes.txt into a table the test creates.
func testImporter(runs *atomic.Int32, fail error) Importer {
	return Importer{Name: "notes", Run: func(ctx context.Context, tx *sql.Tx, env ImportEnv) (ImportResult, error) {
		runs.Add(1)
		var result ImportResult
		if _, err := tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS notes (body TEXT NOT NULL)`); err != nil {
			return result, err
		}
		raw, err := os.ReadFile(filepath.Join(env.StateDir, "notes.txt"))
		if os.IsNotExist(err) {
			return result, nil
		}
		if err != nil {
			return result, err
		}
		result.Rename = []string{"notes.txt"}
		for i, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
			if strings.HasPrefix(line, "!") {
				result.Rejects = append(result.Rejects, stateimport.Reject{Source: "notes.txt", Line: i + 1, Error: "bang", Raw: line})
				continue
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO notes (body) VALUES (?)`, line); err != nil {
				return result, err
			}
		}
		if fail != nil {
			return result, fail
		}
		return result, nil
	}}
}

func withImporter(t *testing.T, importer Importer) {
	t.Helper()
	registryMu.Lock()
	saved := registry
	registry = map[string]Importer{importer.Name: importer}
	registryMu.Unlock()
	t.Cleanup(func() {
		registryMu.Lock()
		registry = saved
		registryMu.Unlock()
	})
}

func countNotes(t *testing.T, db *DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow(`SELECT COUNT(*) FROM notes`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestImportRunsOnceRenamesAndListsRejects(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "notes.txt"), []byte("a\n!b\nc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var runs atomic.Int32
	withImporter(t, testImporter(&runs, nil))
	db, err := OpenStateDir(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	if got := countNotes(t, db); got != 2 {
		t.Fatalf("notes = %d, want 2", got)
	}
	rejects, err := Rejects(context.Background(), db, "notes")
	if err != nil || rejects.Count != 1 || rejects.Rejects[0].Line != 2 || rejects.Rejects[0].Raw != "!b" {
		t.Fatalf("rejects = %+v, %v", rejects, err)
	}
	_ = db.Close()
	if _, err := os.Stat(filepath.Join(state, "notes.txt.imported")); err != nil {
		t.Fatalf("not renamed: %v", err)
	}
	info, err := os.Stat(filepath.Join(state, "agent.db"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("agent.db mode = %v, %v", info.Mode(), err)
	}
	// A file that shows up again is not imported a second time.
	if err := os.WriteFile(filepath.Join(state, "notes.txt"), []byte("z\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	db, err = OpenStateDir(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if got := countNotes(t, db); got != 2 || runs.Load() != 1 {
		t.Fatalf("notes = %d, runs = %d", got, runs.Load())
	}
	// Its .imported name is taken, so it is left where it is.
	if _, err := os.Stat(filepath.Join(state, "notes.txt")); err != nil {
		t.Fatalf("second file moved: %v", err)
	}
}

func TestImportFailureLeavesNothing(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "notes.txt"), []byte("a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var runs atomic.Int32
	withImporter(t, testImporter(&runs, fmt.Errorf("disk on fire")))
	if _, err := OpenStateDir(context.Background(), state); err == nil {
		t.Fatal("open succeeded with a failing import")
	}
	if _, err := os.Stat(filepath.Join(state, "notes.txt")); err != nil {
		t.Fatalf("file moved after a failed import: %v", err)
	}
	// The retry, with the importer fixed, imports everything once.
	withImporter(t, testImporter(&runs, nil))
	db, err := OpenStateDir(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if got := countNotes(t, db); got != 1 {
		t.Fatalf("notes = %d", got)
	}
}

func TestCrashBetweenCommitAndRename(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "notes.txt"), []byte("a\nb\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var runs atomic.Int32
	withImporter(t, testImporter(&runs, nil))
	db, err := OpenStateDir(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	_ = db.Close()
	// Undo the rename, as if the process had died right after the commit.
	if err := os.Rename(filepath.Join(state, "notes.txt.imported"), filepath.Join(state, "notes.txt")); err != nil {
		t.Fatal(err)
	}
	db, err = OpenStateDir(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if got := countNotes(t, db); got != 2 || runs.Load() != 1 {
		t.Fatalf("notes = %d, runs = %d: the import ran again", got, runs.Load())
	}
	if _, err := os.Stat(filepath.Join(state, "notes.txt.imported")); err != nil {
		t.Fatalf("reopen did not finish the rename: %v", err)
	}
}

func TestUnregisteredImporterLeavesFilesAndNoMark(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "notes.txt"), []byte("a\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	withImporter(t, Importer{Name: "other", Run: func(context.Context, *sql.Tx, ImportEnv) (ImportResult, error) {
		return ImportResult{}, nil
	}})
	db, err := OpenStateDir(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	if done, err := stateimport.Imported(context.Background(), db, "notes"); err != nil || done {
		t.Fatalf("notes marked imported by a process without its importer: %v, %v", done, err)
	}
	_ = db.Close()
	var runs atomic.Int32
	withImporter(t, testImporter(&runs, nil))
	db, err = OpenStateDir(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if got := countNotes(t, db); got != 1 {
		t.Fatalf("notes = %d", got)
	}
}

func TestConcurrentOpensImportOnce(t *testing.T) {
	state := t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "notes.txt"), []byte("a\nb\nc\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var runs atomic.Int32
	withImporter(t, testImporter(&runs, nil))
	path := filepath.Join(state, "agent.db")
	// Separate pools, as separate processes would have.
	var wg sync.WaitGroup
	errs := make(chan error, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			db, err := sqlitedb.OpenWithOptions(context.Background(), path, migrations(), sqlitedb.Options{Durable: true})
			if err != nil {
				errs <- err
				return
			}
			defer func() { _ = db.Close() }()
			if _, err := runImport(context.Background(), db, state, testImporter(&runs, nil), slog.Default()); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatal(err)
	}
	db, err := Open(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	if got := countNotes(t, db); got != 3 || runs.Load() != 1 {
		t.Fatalf("notes = %d, runs = %d", got, runs.Load())
	}
}

func TestEmptyFirstRunCreatesEmptySchema(t *testing.T) {
	state := t.TempDir()
	db, err := OpenStateDir(context.Background(), state)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var version int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&version); err != nil || version != len(migrations()) {
		t.Fatalf("user_version = %d, want %d (%v)", version, len(migrations()), err)
	}
	var sync string
	if err := db.QueryRow(`PRAGMA synchronous`).Scan(&sync); err != nil || sync != "2" {
		t.Fatalf("synchronous = %s, want 2 (FULL): %v", sync, err)
	}
	entries, err := os.ReadDir(state)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), stateimport.ImportedSuffix) {
			t.Fatalf("empty state renamed %s", entry.Name())
		}
	}
}

// An empty state folder or path is no database, not agent.db in the working directory.
func TestEmptyPathsNeverOpenInWorkingDirectory(t *testing.T) {
	t.Chdir(t.TempDir())
	ctx := context.Background()
	for name, lazy := range map[string]*Lazy{
		"cached":           Cached(""),
		"cached state dir": CachedStateDir(" "),
		"cached beside":    CachedBeside(""),
	} {
		t.Run(name, func(t *testing.T) {
			if lazy.Path() != "" {
				t.Fatalf("Path() = %q, want none", lazy.Path())
			}
			if db, err := lazy.Get(ctx); err == nil {
				_ = db.Close()
				t.Fatal("Get() opened a database for an empty path")
			}
		})
	}
	if _, err := OpenStateDir(ctx, ""); err == nil {
		t.Fatal("OpenStateDir(\"\") opened a database")
	}
	if matches, _ := filepath.Glob("agent.db*"); len(matches) > 0 {
		t.Fatalf("working directory has %v", matches)
	}
	beside := CachedBeside(filepath.Join(t.TempDir(), "cron.yaml"))
	if !filepath.IsAbs(beside.Path()) || filepath.Base(beside.Path()) != "agent.db" {
		t.Fatalf("CachedBeside path = %q", beside.Path())
	}
}

// The config opens agent.db before the settings the imports read are loaded; the imports wait for
// the next Open or Get, even while the config's handle keeps the pool open.
func TestOpenWithoutImportsDefersThemToTheNextOpen(t *testing.T) {
	var runs atomic.Int32
	withImporter(t, testImporter(&runs, nil))
	ctx := context.Background()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("one\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	lazy := NewLazy(filepath.Join(dir, "agent.db"))
	defer func() { _ = lazy.Close() }()
	config, err := lazy.GetWithoutImports(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if done, err := stateimport.Imported(ctx, config, "notes"); err != nil || done || runs.Load() != 0 {
		t.Fatalf("imported before any open with imports: done=%v runs=%d err=%v", done, runs.Load(), err)
	}
	if _, err := os.Stat(filepath.Join(dir, "notes.txt")); err != nil {
		t.Fatalf("notes.txt renamed by an open without imports: %v", err)
	}
	db, err := lazy.Get(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if runs.Load() != 1 {
		t.Fatalf("runs after Get = %d, want 1", runs.Load())
	}
	other, err := Open(ctx, filepath.Join(dir, "agent.db"))
	if err != nil {
		t.Fatal(err)
	}
	_ = other.Close()
	if runs.Load() != 1 {
		t.Fatalf("runs after a second open = %d, want 1", runs.Load())
	}
	var n int
	if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM notes`).Scan(&n); err != nil || n != 1 {
		t.Fatalf("notes = %d, %v", n, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "notes.txt.imported")); err != nil {
		t.Fatalf("notes.txt not renamed: %v", err)
	}
}
