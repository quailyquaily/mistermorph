// Package stateimport holds what the one-time imports of state files into agent.db and usage.db
// share: the list of records that did not parse, and the renaming of an imported file to
// <name>.imported once the import has committed.
//
// An import runs in one transaction, which also writes an import mark naming the files it read.
// The files are renamed only after that transaction commits, and every open of the database
// finishes the renames a crash left undone, so an import is neither lost nor run twice.
package stateimport

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ImportedSuffix is appended to an imported file's name.
const ImportedSuffix = ".imported"

const (
	markPrefix   = "imported:"
	rejectPrefix = "import_rejects:"
	// maxRejects bounds the rejects kept per store; the count goes on past it.
	maxRejects = 1000
	maxRawLen  = 2048
)

// MetaTableSQL creates the meta table each database has, for import marks and settings.
const MetaTableSQL = `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`

// Execer is a *sql.Tx or a *sql.DB.
type Execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Reject is a record an import skipped because it did not parse or validate.
type Reject struct {
	// Source is the file, relative to the state folder.
	Source string `json:"source"`
	// Line is the line in a line-based file, or the position of the record; 0 when unknown.
	Line  int    `json:"line,omitempty"`
	Error string `json:"error"`
	// Raw is the record as it was, cut at 2 KiB.
	Raw string `json:"raw,omitempty"`
}

// RejectList is what meta holds under import_rejects:<store>.
type RejectList struct {
	Count   int      `json:"count"`
	Rejects []Reject `json:"rejects"`
}

// Mark is what meta holds under imported:<store>.
type Mark struct {
	At string `json:"at"`
	// Rename are the files and folders read, relative to the database's folder; each becomes
	// <path>.imported.
	Rename []string `json:"rename,omitempty"`
	// Delete are derived files the import makes obsolete, relative to the database's folder.
	Delete []string `json:"delete,omitempty"`
}

// AddRejects appends rejects to the store's list in meta.
func AddRejects(ctx context.Context, tx Execer, store string, rejects []Reject) error {
	if len(rejects) == 0 {
		return nil
	}
	list, err := readRejects(ctx, tx, store)
	if err != nil {
		return err
	}
	for _, reject := range rejects {
		list.Count++
		if len(list.Rejects) >= maxRejects {
			continue
		}
		if len(reject.Raw) > maxRawLen {
			reject.Raw = reject.Raw[:maxRawLen]
		}
		list.Rejects = append(list.Rejects, reject)
	}
	data, err := json.Marshal(list)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, rejectPrefix+store, string(data))
	return err
}

// Rejects returns the store's reject list.
func Rejects(ctx context.Context, db Execer, store string) (RejectList, error) {
	return readRejects(ctx, db, store)
}

func readRejects(ctx context.Context, db Execer, store string) (RejectList, error) {
	var raw string
	err := db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, rejectPrefix+store).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return RejectList{}, nil
	}
	if err != nil {
		return RejectList{}, err
	}
	var list RejectList
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return RejectList{}, fmt.Errorf("decode %s%s: %w", rejectPrefix, store, err)
	}
	return list, nil
}

// Imported reports whether the store's import mark is present.
func Imported(ctx context.Context, db Execer, store string) (bool, error) {
	var raw string
	err := db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, markPrefix+store).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}

// SetMark writes the store's import mark in the import's transaction. root is the database's
// folder, which rename and remove are relative to. Paths that do not exist are left out, so a
// store with nothing to import still gets a mark.
func SetMark(ctx context.Context, tx Execer, store, root string, rename, remove []string) error {
	mark := Mark{At: time.Now().UTC().Format(time.RFC3339)}
	for _, rel := range rename {
		if exists(filepath.Join(root, filepath.FromSlash(rel))) {
			mark.Rename = append(mark.Rename, filepath.ToSlash(rel))
		}
	}
	for _, rel := range remove {
		if exists(filepath.Join(root, filepath.FromSlash(rel))) {
			mark.Delete = append(mark.Delete, filepath.ToSlash(rel))
		}
	}
	data, err := json.Marshal(mark)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, markPrefix+store, string(data))
	return err
}

// FinishRenames renames the files every import mark names that are still in place, and deletes
// the derived files they name. It runs after each open: an import commits before it renames, so a
// crash between the two leaves files this finishes. A file whose .imported name is taken is left
// alone and logged rather than overwriting the earlier original.
func FinishRenames(ctx context.Context, db *sql.DB, root string, logger *slog.Logger) error {
	rows, err := db.QueryContext(ctx, `SELECT key, value FROM meta WHERE key LIKE 'imported:%' ORDER BY key`)
	if err != nil {
		return err
	}
	var marks []Mark
	for rows.Next() {
		var key, raw string
		if err := rows.Scan(&key, &raw); err != nil {
			_ = rows.Close()
			return err
		}
		var mark Mark
		if err := json.Unmarshal([]byte(raw), &mark); err != nil {
			continue
		}
		marks = append(marks, mark)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	var errs []error
	for _, mark := range marks {
		for _, rel := range mark.Rename {
			if err := renameImported(filepath.Join(root, filepath.FromSlash(rel)), logger); err != nil {
				errs = append(errs, err)
			}
		}
		for _, rel := range mark.Delete {
			if err := os.RemoveAll(filepath.Join(root, filepath.FromSlash(rel))); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

func renameImported(path string, logger *slog.Logger) error {
	if !exists(path) {
		return nil
	}
	target := path + ImportedSuffix
	if exists(target) {
		if logger != nil {
			logger.Warn("state_import_rename_skipped", "path", path, "reason", "imported copy already exists")
		}
		return nil
	}
	if err := os.Rename(path, target); err != nil {
		return fmt.Errorf("rename imported %s: %w", path, err)
	}
	return nil
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

// SortedGlob is filepath.Glob in name order, without errors for a bad pattern.
func SortedGlob(pattern string) []string {
	matches, _ := filepath.Glob(pattern)
	sort.Strings(matches)
	return matches
}

// Rel returns path relative to root, or path when it is not under root.
func Rel(root, path string) string {
	rel, err := filepath.Rel(root, path)
	if err != nil || strings.HasPrefix(rel, "..") {
		return path
	}
	return filepath.ToSlash(rel)
}
