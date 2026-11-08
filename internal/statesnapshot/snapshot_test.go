package statesnapshot

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
)

func openTestDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	db, err := sqlitedb.Open(context.Background(), path, []sqlitedb.Migration{{
		Name: "create rows",
		SQL:  `CREATE TABLE rows (id INTEGER PRIMARY KEY, body TEXT NOT NULL)`,
	}})
	if err != nil {
		t.Fatalf("open %s: %v", path, err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func TestSnapshotDuringWritesPassesIntegrityCheck(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	agent := openTestDB(t, filepath.Join(state, "agent.db"))
	journal := openTestDB(t, filepath.Join(state, "journal", "journal.db"))
	if err := os.MkdirAll(filepath.Join(state, "persona"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "persona", "avatar.webp"), []byte("img"), 0o600); err != nil {
		t.Fatal(err)
	}

	var stop atomic.Bool
	var wg sync.WaitGroup
	var written atomic.Int64
	for _, db := range []*sql.DB{agent, journal} {
		wg.Add(1)
		go func(db *sql.DB) {
			defer wg.Done()
			body := strings.Repeat("x", 2048)
			for i := 0; !stop.Load(); i++ {
				tx, err := db.BeginTx(ctx, nil)
				if err != nil {
					t.Error(err)
					return
				}
				for k := 0; k < 20; k++ {
					if _, err := tx.ExecContext(ctx, `INSERT INTO rows (body) VALUES (?)`, fmt.Sprintf("%d-%d-%s", i, k, body)); err != nil {
						_ = tx.Rollback()
						t.Error(err)
						return
					}
				}
				if err := tx.Commit(); err != nil {
					t.Error(err)
					return
				}
				written.Add(20)
			}
		}(db)
	}

	for written.Load() < 200 {
		time.Sleep(time.Millisecond)
	}
	for round := 0; round < 3; round++ {
		dst := filepath.Join(t.TempDir(), "snap")
		result, err := Take(ctx, state, dst, Options{})
		if err != nil {
			t.Fatalf("Take: %v", err)
		}
		if got := strings.Join(result.Databases, ","); got != "journal,agent" {
			t.Fatalf("databases = %q", got)
		}
		for _, rel := range []string{"agent.db", filepath.Join("journal", "journal.db")} {
			path := filepath.Join(dst, rel)
			if err := sqlitedb.IntegrityCheck(ctx, path); err != nil {
				t.Fatalf("%s: %v", rel, err)
			}
			for _, suffix := range sqlitedb.SidecarSuffixes {
				if _, err := os.Stat(path + suffix); err == nil {
					t.Fatalf("snapshot copied sidecar %s%s", rel, suffix)
				}
			}
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm() != 0o600 {
				t.Fatalf("%s mode = %v", rel, info.Mode().Perm())
			}
		}
		if data, err := os.ReadFile(filepath.Join(dst, "persona", "avatar.webp")); err != nil || string(data) != "img" {
			t.Fatalf("avatar = %q, %v", data, err)
		}
	}
	stop.Store(true)
	wg.Wait()
}

func TestSnapshotSkipsDatabases(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	openTestDB(t, filepath.Join(state, "usage.db"))
	openTestDB(t, filepath.Join(state, "agent.db"))
	dst := filepath.Join(t.TempDir(), "snap")
	result, err := Take(ctx, state, dst, Options{Skip: []string{"usage"}})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(result.Databases, ","); got != "agent" {
		t.Fatalf("databases = %q", got)
	}
	for _, name := range []string{"usage.db", "usage.db-wal", "usage.db-shm"} {
		if _, err := os.Stat(filepath.Join(dst, name)); err == nil {
			t.Fatalf("%s was copied", name)
		}
	}
	if _, err := Take(ctx, state, filepath.Join(t.TempDir(), "x"), Options{Skip: []string{"nope"}}); err == nil {
		t.Fatal("unknown database name accepted")
	}
}

func TestSnapshotRefusesNonEmptyOrInsideTarget(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	if _, err := Take(ctx, state, state, Options{}); err == nil {
		t.Fatal("snapshot into the state folder accepted")
	}
	dst := t.TempDir()
	if err := os.WriteFile(filepath.Join(dst, "x"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := Take(ctx, state, dst, Options{}); err == nil {
		t.Fatal("non-empty snapshot folder accepted")
	}
	// A snapshot folder inside the state folder is not copied into itself.
	if err := os.WriteFile(filepath.Join(state, "a.txt"), []byte("a"), 0o600); err != nil {
		t.Fatal(err)
	}
	inner := filepath.Join(state, "snap")
	result, err := Take(ctx, state, inner, Options{})
	if err != nil {
		t.Fatal(err)
	}
	if result.Files != 1 {
		t.Fatalf("files = %d", result.Files)
	}
	if _, err := os.Stat(filepath.Join(inner, "snap")); err == nil {
		t.Fatal("snapshot copied itself")
	}
}
