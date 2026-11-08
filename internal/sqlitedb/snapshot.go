package sqlitedb

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

// SidecarSuffixes are the files SQLite keeps next to a database: the write-ahead log, its shared
// memory index and a rollback journal. A copy of a database file without them, or with them taken
// at another moment, may not open.
var SidecarSuffixes = []string{"-wal", "-shm", "-journal"}

// SnapshotInto writes a consistent copy of the database at src to dst with VACUUM INTO, while
// other connections, in this process or another, go on reading and writing it. The copy is one
// file without a WAL, readable only by its owner. src is opened without running migrations and is
// not created when missing; dst must not exist yet.
func SnapshotInto(ctx context.Context, src, dst string) error {
	src = filepath.Clean(strings.TrimSpace(src))
	dst = filepath.Clean(strings.TrimSpace(dst))
	if _, err := os.Stat(src); err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		return fmt.Errorf("snapshot %s: %s already exists", src, dst)
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := fsstore.EnsureDir(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	query := url.Values{}
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", BusyTimeout.Milliseconds()))
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(src)+"?"+query.Encode())
	if err != nil {
		return fmt.Errorf("open %s: %w", src, err)
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	// The copy starts empty with the owner-only mode; VACUUM INTO accepts an existing empty file.
	file, err := os.OpenFile(dst, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create %s: %w", dst, err)
	}
	if err := file.Close(); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "VACUUM INTO ?", dst); err != nil {
		_ = os.Remove(dst)
		return fmt.Errorf("snapshot %s: %w", src, err)
	}
	return nil
}

// IntegrityCheck runs PRAGMA integrity_check on the database at path and returns an error unless
// it reports "ok".
func IntegrityCheck(ctx context.Context, path string) error {
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(filepath.Clean(path))+"?mode=ro")
	if err != nil {
		return err
	}
	defer func() { _ = db.Close() }()
	rows, err := db.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	var problems []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return err
		}
		if line != "ok" {
			problems = append(problems, line)
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(problems) > 0 {
		return fmt.Errorf("integrity check of %s: %s", path, strings.Join(problems, "; "))
	}
	return nil
}
