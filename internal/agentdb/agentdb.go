// Package agentdb opens agent.db, the SQLite database that holds the agent's own state: config,
// persona and heartbeat, contacts, TODO, Console sessions, Agent Link peers and topic state.
//
// The schema of every table is here, in one list of migrations, so the database has one
// user_version whichever store opens it first. The stores themselves live with the code that uses
// them and take a *DB.
//
// Each store's files from an older version are imported once by an Importer the store's package
// registers. An import runs in one transaction that also writes an import mark in meta; the files
// are renamed <name>.imported only after it commits, and every open finishes renames a crash left
// undone. A process that does not link a store's package does not import its files, and does not
// mark them imported either.
package agentdb

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
)

// DB is a handle on agent.db. Handles on one file share a connection pool in the process; Close
// releases this handle.
type DB struct {
	*sql.DB
	path    string
	release func()
	once    sync.Once
}

// Path is the database file.
func (d *DB) Path() string { return d.path }

// StateDir is the folder agent.db is in, which the imported files were relative to.
func (d *DB) StateDir() string { return filepath.Dir(d.path) }

// Close releases the handle. The pool closes when the last handle on the file is released.
func (d *DB) Close() error {
	if d == nil {
		return nil
	}
	d.once.Do(func() {
		if d.release != nil {
			d.release()
		}
	})
	return nil
}

// ImportEnv is what an importer gets to find its files.
type ImportEnv struct {
	// StateDir is the folder agent.db is in.
	StateDir string
	Logger   *slog.Logger
}

// ImportResult is what an importer read and skipped.
type ImportResult struct {
	// Rename are the files and folders read, relative to StateDir; each becomes <path>.imported
	// once the import commits.
	Rename []string
	// Delete are derived files the import makes obsolete, relative to StateDir.
	Delete []string
	// Rejects are the records that did not parse; the rest is imported.
	Rejects []stateimport.Reject
}

// Importer imports one store's files into its tables, inside tx.
type Importer struct {
	// Name is the store; its mark in meta is imported:<Name> and its rejects import_rejects:<Name>.
	Name string
	// Order runs importers in ascending order, so one can rely on another's rows.
	Order int
	Run   func(ctx context.Context, tx *sql.Tx, env ImportEnv) (ImportResult, error)
}

var (
	registryMu sync.Mutex
	registry   = map[string]Importer{}
)

// Register adds an importer that runs on every open of agent.db until its mark is set. It is meant
// for package init functions.
func Register(importer Importer) {
	if strings.TrimSpace(importer.Name) == "" || importer.Run == nil {
		panic("agentdb: importer needs a name and a Run function")
	}
	registryMu.Lock()
	defer registryMu.Unlock()
	registry[importer.Name] = importer
}

func registered() []Importer {
	registryMu.Lock()
	defer registryMu.Unlock()
	out := make([]Importer, 0, len(registry))
	for _, importer := range registry {
		out = append(out, importer)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].Name < out[j].Name
	})
	return out
}

var shared = sqlitedb.NewShared()

// Path is agent.db in the configured state folder.
func Path() string {
	return statepaths.AgentDBPath()
}

// Open opens agent.db at path, creating it with an empty schema when missing, and runs the
// registered imports that have not run yet.
func Open(ctx context.Context, path string) (*DB, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "" || path == "." {
		return nil, fmt.Errorf("agent database path is required")
	}
	logger := slog.Default()
	db, release, err := shared.Acquire(path, func() (*sql.DB, error) {
		db, err := sqlitedb.OpenWithOptions(ctx, path, migrations(), sqlitedb.Options{Durable: true})
		if err != nil {
			return nil, fmt.Errorf("open agent database: %w", err)
		}
		stateDir := filepath.Dir(path)
		if err := stateimport.FinishRenames(ctx, db, stateDir, logger); err != nil {
			logger.Warn("agent_db_import_rename_failed", "error", err)
		}
		for _, importer := range registered() {
			if _, err := runImport(ctx, db, stateDir, importer, logger); err != nil {
				_ = db.Close()
				return nil, fmt.Errorf("import %s into agent database: %w", importer.Name, err)
			}
		}
		return db, nil
	})
	if err != nil {
		return nil, err
	}
	return &DB{DB: db, path: path, release: release}, nil
}

// OpenStateDir opens agent.db in stateDir.
func OpenStateDir(ctx context.Context, stateDir string) (*DB, error) {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return nil, fmt.Errorf("state folder is required")
	}
	return Open(ctx, filepath.Join(stateDir, statepaths.AgentDBFilename))
}

// RunImport runs importer now unless its mark is set, for an import that only some opens should
// run (the config, which is imported only when no --config names a file). It reports whether the
// import ran.
func RunImport(ctx context.Context, db *DB, importer Importer) (bool, error) {
	if db == nil {
		return false, fmt.Errorf("agent database is not open")
	}
	return runImport(ctx, db.DB, db.StateDir(), importer, slog.Default())
}

func runImport(ctx context.Context, db *sql.DB, stateDir string, importer Importer, logger *slog.Logger) (bool, error) {
	if done, err := stateimport.Imported(ctx, db, importer.Name); err != nil || done {
		return false, err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	// Another process may have imported while this one waited for the write lock.
	if done, err := stateimport.Imported(ctx, tx, importer.Name); err != nil || done {
		return false, err
	}
	result, err := importer.Run(ctx, tx, ImportEnv{StateDir: stateDir, Logger: logger})
	if err != nil {
		return false, err
	}
	if err := stateimport.AddRejects(ctx, tx, importer.Name, result.Rejects); err != nil {
		return false, err
	}
	if err := stateimport.SetMark(ctx, tx, importer.Name, stateDir, result.Rename, result.Delete); err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	if len(result.Rejects) > 0 {
		logger.Warn("agent_db_import_rejects", "store", importer.Name, "count", len(result.Rejects))
	}
	if err := stateimport.FinishRenames(ctx, db, stateDir, logger); err != nil {
		logger.Warn("agent_db_import_rename_failed", "store", importer.Name, "error", err)
	}
	return true, nil
}

// Rejects returns the records a store's import skipped.
func Rejects(ctx context.Context, db *DB, store string) (stateimport.RejectList, error) {
	return stateimport.Rejects(ctx, db, store)
}

// Lazy opens agent.db on first use and keeps the handle, for stores built from a path in many
// places that have no Close of their own. A database file replaced since (a test that removes its
// folder) is opened again.
type Lazy struct {
	path string
	mu   sync.Mutex
	db   *DB
	file os.FileInfo
}

// NewLazy returns a lazy handle on agent.db at path; an empty path never opens.
func NewLazy(path string) *Lazy {
	return &Lazy{path: strings.TrimSpace(path)}
}

// Path is the database file, or "" when the handle has none.
func (l *Lazy) Path() string {
	if l == nil {
		return ""
	}
	return l.path
}

// Get returns the open database.
func (l *Lazy) Get(ctx context.Context) (*DB, error) {
	if l == nil || l.path == "" {
		return nil, fmt.Errorf("agent database path is required")
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.db != nil {
		if current, err := os.Stat(l.path); err == nil && l.file != nil && os.SameFile(current, l.file) {
			return l.db, nil
		}
		_ = l.db.Close()
		l.db = nil
	}
	db, err := Open(ctx, l.path)
	if err != nil {
		return nil, err
	}
	l.db = db
	l.file, _ = os.Stat(l.path)
	return db, nil
}

// Close releases the handle; a later Get opens it again.
func (l *Lazy) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.db == nil {
		return nil
	}
	err := l.db.Close()
	l.db = nil
	return err
}

// Now is the current time as agent.db stores times: RFC 3339 in UTC.
func Now() string {
	return FormatTime(time.Now())
}

// FormatTime formats t as agent.db stores times: RFC 3339 in UTC, to the second, so the text sorts
// and compares as the times do. The zero time is "".
func FormatTime(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(time.RFC3339)
}

// preciseLayout is RFC 3339 with all nine fraction digits, a fixed width that still sorts.
const preciseLayout = "2006-01-02T15:04:05.000000000Z07:00"

// FormatTimePrecise is FormatTime to the nanosecond, for records whose times are compared
// exactly when read back (the bus outbox).
func FormatTimePrecise(t time.Time) string {
	if t.IsZero() {
		return ""
	}
	return t.UTC().Format(preciseLayout)
}

// ParseTime reads a time agent.db stored; "" is the zero time.
func ParseTime(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return time.Time{}, nil
	}
	return time.Parse(time.RFC3339Nano, raw)
}

// NullTime is t for a nullable time column: NULL for the zero time.
func NullTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return FormatTime(t)
}

// Bool is v as a 0/1 column.
func Bool(v bool) int {
	if v {
		return 1
	}
	return 0
}

var (
	cachedMu sync.Mutex
	cached   = map[string]*Lazy{}
)

// Cached returns a process-wide lazy handle on agent.db at path, for readers that run often and
// keep no handle of their own (the prompt's persona, a heartbeat tick). It opens on first use and
// stays open. An empty path gives a handle that never opens: it is not agent.db in the working
// directory.
func Cached(path string) *Lazy {
	path = strings.TrimSpace(path)
	if path == "" {
		return NewLazy("")
	}
	path = filepath.Clean(path)
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	cachedMu.Lock()
	defer cachedMu.Unlock()
	lazy := cached[path]
	if lazy == nil {
		lazy = NewLazy(path)
		cached[path] = lazy
	}
	return lazy
}

// CachedStateDir is Cached for agent.db in stateDir. An empty stateDir gives a handle that never
// opens, the way OpenStateDir refuses one.
func CachedStateDir(stateDir string) *Lazy {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return NewLazy("")
	}
	return Cached(filepath.Join(stateDir, statepaths.AgentDBFilename))
}

// CachedBeside is Cached for agent.db in the folder that holds path (cron.yaml, config.yaml, the
// contacts folder). An empty path gives a handle that never opens.
func CachedBeside(path string) *Lazy {
	path = strings.TrimSpace(path)
	if path == "" {
		return NewLazy("")
	}
	return CachedStateDir(filepath.Dir(filepath.Clean(path)))
}
