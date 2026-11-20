// Package dbmetrics reports the size and the row counts of the state folder's SQLite databases,
// for the runtime overview. It reads aggregates only: file sizes and COUNT(*) of named tables,
// never a row's content, and it names a database by its file name, never by its path.
//
// A count is a scan of the table's smallest index, so counts are kept: a database is counted
// again only when its files have changed since the last count (or that count left something
// unknown) and that count is older than MinRecount. One collection spends at most Budget on counting; what it could not count is
// reported as unknown (a nil Rows), never as zero.
package dbmetrics

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/statepaths"

	_ "modernc.org/sqlite"
)

const (
	// StatusOK: the database file is there and could be read.
	StatusOK = "ok"
	// StatusMissing: the database has not been created (nothing has written to it yet).
	StatusMissing = "missing"
	// StatusUnavailable: the file could not be inspected or read.
	StatusUnavailable = "unavailable"
)

const (
	// MinRecount is the shortest time between two counts of one database.
	MinRecount = 30 * time.Second
	// Budget is the longest one collection spends counting, over all databases.
	Budget = 1500 * time.Millisecond
)

// Spec names one database and the tables whose rows are counted.
type Spec struct {
	// Name is the database's short name, as `state snapshot --skip` has it.
	Name string
	// Path is relative to the state folder.
	Path string
	// Tables are counted with COUNT(*), each reported under its own name.
	Tables []string
}

// Specs are the runtime's databases (statesnapshot.Databases) and, for each, the tables that hold
// its records. Bookkeeping tables (meta, full-text indexes, import rejects) are left out.
var Specs = []Spec{
	{Name: "agent", Path: statepaths.AgentDBFilename, Tables: []string{"contacts", "jobs", "topic_contexts"}},
	{Name: "journal", Path: filepath.Join(statepaths.JournalDirName, "journal.db"), Tables: []string{"journal_events"}},
	{Name: "memory", Path: statepaths.MemoryDBFilename, Tables: []string{"memories"}},
	{Name: "usage", Path: statepaths.UsageDBFilename, Tables: []string{"llm_requests"}},
}

// Table is one counted table.
type Table struct {
	Name string `json:"name"`
	// Rows is the table's row count; nil when it is unknown (the table is not there, or the count
	// failed or ran out of time).
	Rows *int64 `json:"rows"`
}

// Database is one database's metrics.
type Database struct {
	Name string `json:"name"`
	// File is the file's base name ("agent.db"), not its path.
	File   string `json:"file"`
	Status string `json:"status"`
	// SizeBytes is the database file plus its write-ahead log (what was written and not yet
	// checkpointed lives there); nil when the file is missing or could not be inspected.
	SizeBytes *int64  `json:"size_bytes"`
	Tables    []Table `json:"tables"`
}

type fileMark struct {
	size    int64
	modTime time.Time
}

type signature struct {
	db, wal fileMark
}

type counted struct {
	sig signature
	at  time.Time
	ok  bool
	// complete: every table was counted, so the count holds until the files change.
	complete bool
	tables   []Table
}

// Collector collects the metrics of one state folder's databases and keeps the counts.
type Collector struct {
	stateDir string
	specs    []Spec

	mu    sync.Mutex
	cache map[string]counted

	now        func() time.Time
	minRecount time.Duration
	budget     time.Duration
	// countHook is called before each database is counted (tests).
	countHook func(name string)
}

// New returns a collector for the databases in stateDir, or nil when stateDir is empty: no state
// folder, no databases to report.
func New(stateDir string) *Collector {
	stateDir = strings.TrimSpace(stateDir)
	if stateDir == "" {
		return nil
	}
	return &Collector{
		stateDir:   filepath.Clean(stateDir),
		specs:      Specs,
		cache:      map[string]counted{},
		now:        time.Now,
		minRecount: MinRecount,
		budget:     Budget,
	}
}

// Collect returns every database's metrics, in Specs order. It never fails: what cannot be read
// is reported as missing or unavailable. It creates no database. A nil collector returns nil.
func (c *Collector) Collect(ctx context.Context) []Database {
	if c == nil {
		return nil
	}
	if ctx == nil {
		ctx = context.Background()
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	ctx, cancel := context.WithTimeout(ctx, c.budget)
	defer cancel()
	out := make([]Database, 0, len(c.specs))
	for _, spec := range c.specs {
		out = append(out, c.collectOne(ctx, spec))
	}
	return out
}

func (c *Collector) collectOne(ctx context.Context, spec Spec) Database {
	path := filepath.Join(c.stateDir, spec.Path)
	item := Database{Name: spec.Name, File: filepath.Base(spec.Path), Tables: unknownTables(spec)}

	info, err := os.Stat(path)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		delete(c.cache, spec.Name)
		item.Status = StatusMissing
		return item
	case err != nil || !info.Mode().IsRegular():
		delete(c.cache, spec.Name)
		item.Status = StatusUnavailable
		return item
	}
	sig := signature{db: fileMark{size: info.Size(), modTime: info.ModTime()}}
	size := info.Size()
	// An empty log holds nothing to count: reading a database nobody has open creates one, which
	// must not look like a change.
	if walInfo, walErr := os.Stat(path + "-wal"); walErr == nil && walInfo.Mode().IsRegular() && walInfo.Size() > 0 {
		sig.wal = fileMark{size: walInfo.Size(), modTime: walInfo.ModTime()}
		size += walInfo.Size()
	}
	item.SizeBytes = &size

	now := c.now()
	kept, has := c.cache[spec.Name]
	// Count again when the files changed, or when the last count left something unknown (it may
	// have been a lock, a timeout or a permission since fixed), but never more often than minRecount.
	if !has || ((kept.sig != sig || !kept.complete) && now.Sub(kept.at) >= c.minRecount) {
		if ctx.Err() == nil {
			if c.countHook != nil {
				c.countHook(spec.Name)
			}
			tables, ok := countTables(ctx, path, spec)
			complete := ok
			for _, table := range tables {
				complete = complete && table.Rows != nil
			}
			kept = counted{sig: sig, at: now, ok: ok, complete: complete, tables: tables}
			c.cache[spec.Name] = kept
			has = true
		}
	}
	if !has {
		// Out of time before this database's first count: its size is known, its rows are not.
		item.Status = StatusOK
		return item
	}
	item.Tables = cloneTables(kept.tables)
	if kept.ok {
		item.Status = StatusOK
	} else {
		item.Status = StatusUnavailable
	}
	return item
}

// countTables counts spec's tables over a read-only connection. ok is false when the database
// could not be read at all; a table that is not there, or whose count failed, has nil Rows.
func countTables(ctx context.Context, path string, spec Spec) (tables []Table, ok bool) {
	tables = unknownTables(spec)
	query := url.Values{}
	query.Set("mode", "ro")
	query.Add("_pragma", "busy_timeout(250)")
	query.Add("_pragma", "query_only(1)")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?"+query.Encode())
	if err != nil {
		return tables, false
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	// Reading the schema proves the file is a database this process may read.
	var schemaObjects int64
	if err := db.QueryRowContext(ctx, "SELECT COUNT(*) FROM sqlite_master").Scan(&schemaObjects); err != nil {
		return tables, false
	}
	for i, name := range spec.Tables {
		var rows int64
		// Table names come from Specs, never from a request.
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM "`+strings.ReplaceAll(name, `"`, `""`)+`"`).Scan(&rows); err != nil {
			continue
		}
		tables[i].Rows = &rows
	}
	return tables, true
}

func unknownTables(spec Spec) []Table {
	tables := make([]Table, len(spec.Tables))
	for i, name := range spec.Tables {
		tables[i] = Table{Name: name}
	}
	return tables
}

func cloneTables(in []Table) []Table {
	out := make([]Table, len(in))
	for i, table := range in {
		out[i] = Table{Name: table.Name}
		if table.Rows != nil {
			rows := *table.Rows
			out[i].Rows = &rows
		}
	}
	return out
}
