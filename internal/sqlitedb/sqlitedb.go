// Package sqlitedb opens the SQLite databases mistermorph keeps under its state directory. It uses
// modernc.org/sqlite, a pure-Go build of SQLite, so release builds stay CGO_ENABLED=0.
package sqlitedb

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/fsstore"

	_ "modernc.org/sqlite"
)

// BusyTimeout is how long a connection waits for another connection, in this process or another,
// to release a lock before a statement fails with SQLITE_BUSY.
const BusyTimeout = 10 * time.Second

// Migration is one step of a database's schema. Steps run in order, each once, and the database
// records how many have run in PRAGMA user_version. A released step must never change: add a new one.
type Migration struct {
	// Name says what the step does; it appears in errors.
	Name string
	// SQL runs first, when set. It may hold several statements.
	SQL string
	// Apply runs after SQL, when set, for steps that move data.
	Apply func(ctx context.Context, tx *sql.Tx) error
}

// Open opens the database at path, creating it and its directory when missing, and applies the
// migrations it has not run yet. The file is readable only by its owner, since it can hold private
// messages. The database uses WAL, so readers do not block the writer, and every transaction
// begins IMMEDIATE, so two writers wait for each other instead of failing on a lock upgrade.
func Open(ctx context.Context, path string, migrations []Migration) (*sql.DB, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, fmt.Errorf("sqlite database path is required")
	}
	path = filepath.Clean(path)
	if err := fsstore.EnsureDir(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	// SQLite creates the file with the process umask and gives the -wal and -shm files the same
	// mode as the database, so creating it first is enough to keep all three private.
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create sqlite database: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("create sqlite database: %w", err)
	}

	db, err := sql.Open("sqlite", dsn(path))
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}
	if err := migrate(ctx, db, migrations); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	return db, nil
}

func dsn(path string) string {
	query := url.Values{}
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", BusyTimeout.Milliseconds()))
	query.Add("_pragma", "journal_mode(WAL)")
	query.Add("_pragma", "synchronous(NORMAL)")
	query.Add("_pragma", "foreign_keys(1)")
	query.Set("_txlock", "immediate")
	return "file:" + filepath.ToSlash(path) + "?" + query.Encode()
}

func migrate(ctx context.Context, db *sql.DB, migrations []Migration) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Read the version inside the transaction: another process may have migrated while this one
	// waited for the lock.
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version > len(migrations) {
		return fmt.Errorf("schema version %d is newer than this build, which knows %d", version, len(migrations))
	}
	if version == len(migrations) {
		return nil
	}
	for i := version; i < len(migrations); i++ {
		step := migrations[i]
		if strings.TrimSpace(step.SQL) != "" {
			if _, err := tx.ExecContext(ctx, step.SQL); err != nil {
				return fmt.Errorf("migration %d (%s): %w", i+1, step.Name, err)
			}
		}
		if step.Apply != nil {
			if err := step.Apply(ctx, tx); err != nil {
				return fmt.Errorf("migration %d (%s): %w", i+1, step.Name, err)
			}
		}
	}
	// PRAGMA takes no bound parameters; the value is an int this code computed.
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version = %d", len(migrations))); err != nil {
		return fmt.Errorf("write schema version: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration: %w", err)
	}
	return nil
}

// IsNoRows reports whether err is sql.ErrNoRows.
func IsNoRows(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}
