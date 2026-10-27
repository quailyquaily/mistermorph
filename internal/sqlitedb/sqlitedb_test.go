package sqlitedb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
)

var testMigrations = []Migration{
	{Name: "create items", SQL: `CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL)`},
	{Name: "seed", Apply: func(ctx context.Context, tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, `INSERT INTO items (text) VALUES ('seed')`)
		return err
	}},
}

func userVersion(t *testing.T, db *sql.DB) int {
	t.Helper()
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("read user_version: %v", err)
	}
	return version
}

func countItems(t *testing.T, db *sql.DB) int {
	t.Helper()
	var n int
	if err := db.QueryRow("SELECT count(*) FROM items").Scan(&n); err != nil {
		t.Fatalf("count items: %v", err)
	}
	return n
}

func TestOpenAppliesMigrationsOnce(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "nested", "memory.db")

	db, err := Open(ctx, path, testMigrations)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	if got := userVersion(t, db); got != 2 {
		t.Fatalf("user_version = %d, want 2", got)
	}
	if got := countItems(t, db); got != 1 {
		t.Fatalf("items = %d, want 1", got)
	}
	var mode string
	if err := db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal_mode = %q, %v; want wal", mode, err)
	}
	_ = db.Close()

	db, err = Open(ctx, path, testMigrations)
	if err != nil {
		t.Fatalf("reopen error = %v", err)
	}
	defer db.Close()
	if got := countItems(t, db); got != 1 {
		t.Fatalf("items after reopen = %d, want 1 (seed ran twice)", got)
	}
}

func TestOpenAppliesOnlyNewMigrations(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "memory.db")
	db, err := Open(ctx, path, testMigrations[:1])
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	_ = db.Close()

	db, err = Open(ctx, path, testMigrations)
	if err != nil {
		t.Fatalf("Open() with a new step error = %v", err)
	}
	defer db.Close()
	if got := userVersion(t, db); got != 2 {
		t.Fatalf("user_version = %d, want 2", got)
	}
	if got := countItems(t, db); got != 1 {
		t.Fatalf("items = %d, want 1", got)
	}
}

func TestOpenRollsBackFailedMigration(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "memory.db")
	failing := append(append([]Migration(nil), testMigrations...), Migration{
		Name: "broken",
		Apply: func(ctx context.Context, tx *sql.Tx) error {
			if _, err := tx.ExecContext(ctx, `INSERT INTO items (text) VALUES ('partial')`); err != nil {
				return err
			}
			return errors.New("boom")
		},
	})
	if _, err := Open(ctx, path, failing); err == nil || !strings.Contains(err.Error(), "migration 3 (broken)") {
		t.Fatalf("Open() error = %v, want migration 3 (broken)", err)
	}

	db, err := Open(ctx, path, nil)
	if err != nil {
		t.Fatalf("Open() without migrations error = %v", err)
	}
	defer db.Close()
	if got := userVersion(t, db); got != 0 {
		t.Fatalf("user_version = %d, want 0 after rollback", got)
	}
	var tables int
	if err := db.QueryRow(`SELECT count(*) FROM sqlite_master WHERE name = 'items'`).Scan(&tables); err != nil || tables != 0 {
		t.Fatalf("items table count = %d, %v; want 0 after rollback", tables, err)
	}
}

func TestOpenRefusesNewerSchema(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "memory.db")
	db, err := Open(ctx, path, testMigrations)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	_ = db.Close()

	_, err = Open(ctx, path, testMigrations[:1])
	if err == nil || !strings.Contains(err.Error(), "schema version 2 is newer than this build, which knows 1") {
		t.Fatalf("Open() error = %v, want newer schema refusal", err)
	}
}

func TestOpenCreatesPrivateFile(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("file modes are not POSIX on windows")
	}
	path := filepath.Join(t.TempDir(), "memory.db")
	db, err := Open(context.Background(), path, testMigrations)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("stat: %v", err)
	}
	if mode := info.Mode().Perm(); mode != 0o600 {
		t.Fatalf("mode = %o, want 600", mode)
	}
}

func TestConcurrentWritersWait(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "memory.db")
	// Two handles stand in for two processes: they share nothing but the file.
	first, err := Open(ctx, path, testMigrations)
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer first.Close()
	second, err := Open(ctx, path, testMigrations)
	if err != nil {
		t.Fatalf("second Open() error = %v", err)
	}
	defer second.Close()

	const perWriter = 50
	var wg sync.WaitGroup
	errs := make(chan error, 2*perWriter)
	for w, db := range []*sql.DB{first, second} {
		wg.Add(1)
		go func(w int, db *sql.DB) {
			defer wg.Done()
			for i := 0; i < perWriter; i++ {
				tx, err := db.BeginTx(ctx, nil)
				if err != nil {
					errs <- err
					return
				}
				if _, err := tx.ExecContext(ctx, `INSERT INTO items (text) VALUES (?)`, fmt.Sprintf("w%d-%d", w, i)); err != nil {
					_ = tx.Rollback()
					errs <- err
					return
				}
				if err := tx.Commit(); err != nil {
					errs <- err
					return
				}
			}
		}(w, db)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Fatalf("concurrent write error = %v", err)
	}
	if got := countItems(t, first); got != 1+2*perWriter {
		t.Fatalf("items = %d, want %d", got, 1+2*perWriter)
	}
}

func TestFTS5Trigram(t *testing.T) {
	db, err := Open(context.Background(), filepath.Join(t.TempDir(), "memory.db"), []Migration{{
		Name: "fts",
		SQL:  `CREATE VIRTUAL TABLE notes USING fts5(text, tokenize='trigram')`,
	}})
	if err != nil {
		t.Fatalf("Open() error = %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`INSERT INTO notes (text) VALUES ('リリースノートはDMで送る'), ('release notes go to the owner')`); err != nil {
		t.Fatalf("insert: %v", err)
	}
	for _, query := range []string{"リリース", "notes go"} {
		var n int
		if err := db.QueryRow(`SELECT count(*) FROM notes WHERE notes MATCH ?`, `"`+query+`"`).Scan(&n); err != nil {
			t.Fatalf("match %q: %v", query, err)
		}
		if n != 1 {
			t.Fatalf("match %q = %d rows, want 1", query, n)
		}
	}
}
