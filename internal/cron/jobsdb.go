package cron

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
)

// jobs.db is the job store: the TODO list's jobs, in order, in the state folder. The scheduler,
// the Console and the tools all open it, from one process or several; SQLite's WAL and IMMEDIATE
// transactions keep their changes whole, and every read sees what the others committed.
//
// The first open of a jobs.db imports the list it replaces, once, in one transaction: the
// cron_tasks rows of agent.db when an earlier version had moved the list there, otherwise
// cron.yaml. The import mark in jobs.db's meta table records it; from then on neither source is
// read again, so a job deleted here never comes back. cron.yaml is only read, never renamed or
// changed. A cron.yaml that does not import whole (it does not parse, or a record has no ID,
// repeats one or does not validate) imports nothing: the open fails with an *ImportError naming
// every rejected record, and the next open tries again.

// JobsDBFilename is the job store in the state folder.
const JobsDBFilename = statepaths.JobsDBFilename

const (
	// jobsImportStore names the import in jobs.db's meta table (imported:jobs).
	jobsImportStore = "jobs"
	// jobsRevisionKey is the meta key of the list's revision: it counts the changes to the jobs
	// themselves (not the runs the scheduler records), so a client can save only what it read.
	jobsRevisionKey = "jobs_revision"
	// legacyAgentDBImportMark is the mark agent.db holds once an earlier version imported
	// cron.yaml into its cron_tasks table.
	legacyAgentDBImportMark = "imported:cron"
)

const jobsSQL = `
CREATE TABLE jobs (
	id              TEXT PRIMARY KEY,
	position        INTEGER NOT NULL,
	title           TEXT NOT NULL DEFAULT '',
	enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
	at              TEXT NOT NULL DEFAULT '',
	cron            TEXT NOT NULL DEFAULT '',
	tz              TEXT NOT NULL DEFAULT '',
	content         TEXT NOT NULL,
	chat_id         TEXT NOT NULL DEFAULT '',
	mention         TEXT NOT NULL DEFAULT '',
	llm_profile     TEXT NOT NULL DEFAULT '',
	workspace_dir   TEXT NOT NULL DEFAULT '',
	bash_env        TEXT NOT NULL DEFAULT '[]',
	created_at      TEXT NOT NULL,
	updated_at      TEXT NOT NULL,
	last_run_at     TEXT,
	last_run_status TEXT NOT NULL DEFAULT '',
	CHECK (id <> ''),
	CHECK ((at = '') <> (cron = ''))
);
CREATE INDEX jobs_by_position ON jobs (position);
`

func jobsMigrations() []sqlitedb.Migration {
	return []sqlitedb.Migration{
		{Name: "create jobs and meta", SQL: stateimport.MetaTableSQL + jobsSQL},
	}
}

// JobsDBPath is jobs.db beside the cron.yaml path cronPath: both are in the state folder.
func JobsDBPath(cronPath string) string {
	cronPath = strings.TrimSpace(cronPath)
	if cronPath == "" {
		return ""
	}
	return filepath.Join(filepath.Dir(filepath.Clean(cronPath)), JobsDBFilename)
}

var jobsShared = sqlitedb.NewShared()

// jobsHandle opens jobs.db on first use, runs the legacy import, and keeps the handle. A database
// file replaced since (a test that removes its folder, a restore) is opened again.
type jobsHandle struct {
	path string
	mu   sync.Mutex
	db   *sql.DB
	// release gives the pool back to jobsShared.
	release func()
	file    os.FileInfo
}

var (
	jobsHandlesMu sync.Mutex
	jobsHandles   = map[string]*jobsHandle{}
)

// cachedJobsHandle is the process-wide handle on the jobs.db at path.
func cachedJobsHandle(path string) *jobsHandle {
	path = filepath.Clean(path)
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	jobsHandlesMu.Lock()
	defer jobsHandlesMu.Unlock()
	handle := jobsHandles[path]
	if handle == nil {
		handle = &jobsHandle{path: path}
		jobsHandles[path] = handle
	}
	return handle
}

// get returns the open database once its import has run. An import that fails is returned as
// the error and tried again by the next get.
func (h *jobsHandle) get(ctx context.Context) (*sql.DB, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.db != nil {
		if current, err := os.Stat(h.path); err == nil && h.file != nil && os.SameFile(current, h.file) {
			return h.db, nil
		}
		h.release()
		h.db, h.release, h.file = nil, nil, nil
	}
	db, release, err := jobsShared.Acquire(h.path, func() (*sql.DB, error) {
		db, err := sqlitedb.OpenWithOptions(ctx, h.path, jobsMigrations(), sqlitedb.Options{Durable: true})
		if err != nil {
			return nil, fmt.Errorf("open job database: %w", err)
		}
		return db, nil
	})
	if err != nil {
		return nil, err
	}
	if err := importLegacyJobs(ctx, db, filepath.Dir(h.path)); err != nil {
		release()
		return nil, err
	}
	h.db, h.release = db, release
	h.file, _ = os.Stat(h.path)
	return db, nil
}

// close releases the handle; a later get opens the file again.
func (h *jobsHandle) close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.db != nil {
		h.release()
		h.db, h.release, h.file = nil, nil, nil
	}
}

// ImportReject is a cron.yaml record the import refused. Record is its position in the file,
// from 1.
type ImportReject struct {
	Record int    `json:"record"`
	ID     string `json:"id,omitempty"`
	Error  string `json:"error"`
}

// ImportError is a cron.yaml that could not be imported whole. Nothing was imported; the import
// runs again on the next open, so fixing (or removing) the records it names lets it through.
type ImportError struct {
	// Path is the cron.yaml read.
	Path string
	// Parse is why the file did not parse, when it did not; Rejects is then empty.
	Parse   string
	Rejects []ImportReject
}

func (e *ImportError) Error() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s was not imported into %s (nothing was imported; fix or remove the records named here and the import runs again): ",
		e.Path, JobsDBFilename)
	if e.Parse != "" {
		b.WriteString(e.Parse)
		return b.String()
	}
	for i, reject := range e.Rejects {
		if i > 0 {
			b.WriteString("; ")
		}
		if reject.ID != "" {
			fmt.Fprintf(&b, "record %d (id %q): %s", reject.Record, reject.ID, reject.Error)
		} else {
			fmt.Fprintf(&b, "record %d: %s", reject.Record, reject.Error)
		}
	}
	return b.String()
}

// importMark is what jobs.db's meta table holds under imported:jobs.
type importMark struct {
	At string `json:"at"`
	// Source is where the jobs came from: "agent.db", "cron.yaml", "agent.db+cron.yaml" or ""
	// when there was nothing to import.
	Source string `json:"source,omitempty"`
	Jobs   int    `json:"jobs"`
	// IgnoredYAML is set when a cron.yaml was present but not read, because agent.db had already
	// imported it.
	IgnoredYAML bool `json:"ignored_yaml,omitempty"`
}

// legacyRow is a job as an earlier store kept it, with what the store recorded beside it.
type legacyRow struct {
	task      Task
	createdAt string
	updatedAt string
	lastRunAt sql.NullString
}

// importLegacyJobs runs the one-time import into the jobs.db db, whose state folder is stateDir,
// unless its mark is set.
func importLegacyJobs(ctx context.Context, db *sql.DB, stateDir string) error {
	if done, err := stateimport.Imported(ctx, db, jobsImportStore); err != nil || done {
		return err
	}
	// Read the sources before taking jobs.db's write lock; they are only read.
	agentRows, agentImported, err := readAgentDBJobs(ctx, filepath.Join(stateDir, statepaths.AgentDBFilename))
	if err != nil {
		return fmt.Errorf("read the jobs agent.db holds: %w", err)
	}
	yamlPath := filepath.Join(stateDir, DefaultFilename)
	var yamlTasks []Task
	yamlPresent := false
	if !agentImported {
		yamlTasks, yamlPresent, err = readYAMLJobs(yamlPath, agentRows)
		if err != nil {
			return err
		}
	} else if _, statErr := os.Stat(yamlPath); statErr == nil {
		yamlPresent = true
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Another process may have imported while this one waited for the write lock.
	if done, err := stateimport.Imported(ctx, tx, jobsImportStore); err != nil || done {
		return err
	}
	now := nowText()
	position := 0
	for _, row := range agentRows {
		if err := insertJob(ctx, tx, position, row.task, row.createdAt, row.updatedAt, row.lastRunAt); err != nil {
			return fmt.Errorf("import job %s from agent.db: %w", row.task.ID, err)
		}
		position++
	}
	for _, task := range yamlTasks {
		if err := insertJob(ctx, tx, position, task, now, now, sql.NullString{}); err != nil {
			return fmt.Errorf("import job %s from %s: %w", task.ID, DefaultFilename, err)
		}
		position++
	}
	var sources []string
	if len(agentRows) > 0 || agentImported {
		sources = append(sources, statepaths.AgentDBFilename)
	}
	if len(yamlTasks) > 0 || (yamlPresent && !agentImported) {
		sources = append(sources, DefaultFilename)
	}
	mark := importMark{At: now, Source: strings.Join(sources, "+"), Jobs: position, IgnoredYAML: yamlPresent && agentImported}
	if err := setMeta(ctx, tx, "imported:"+jobsImportStore, mark); err != nil {
		return err
	}
	return tx.Commit()
}

// readAgentDBJobs reads the cron_tasks rows of agent.db at path, in order, and whether agent.db
// imported cron.yaml. A missing agent.db, or one without the table, has none. agent.db is opened
// as it is, without its migrations or imports, and only read.
func readAgentDBJobs(ctx context.Context, path string) ([]legacyRow, bool, error) {
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	} else if err != nil {
		return nil, false, err
	}
	query := url.Values{}
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", sqlitedb.BusyTimeout.Milliseconds()))
	query.Add("_pragma", "query_only(1)")
	query.Set("mode", "rw")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?"+query.Encode())
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = conn.Close() }()
	// One read transaction, so the rows and the mark are one moment of the file.
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = tx.Rollback() }()
	has := func(table string) (bool, error) {
		var n int
		err := tx.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&n)
		return n > 0, err
	}
	imported := false
	if ok, err := has("meta"); err != nil {
		return nil, false, err
	} else if ok {
		var n int
		if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM meta WHERE key = ?`, legacyAgentDBImportMark).Scan(&n); err != nil {
			return nil, false, err
		}
		imported = n > 0
	}
	if ok, err := has("cron_tasks"); err != nil || !ok {
		return nil, imported, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, title, enabled, at, cron, tz, content, chat_id, mention, llm_profile,
		workspace_dir, bash_env, created_at, updated_at, last_run_at, last_run_status FROM cron_tasks ORDER BY position, id`)
	if err != nil {
		return nil, imported, err
	}
	defer func() { _ = rows.Close() }()
	var out []legacyRow
	for rows.Next() {
		var row legacyRow
		var enabled int
		var bashEnv string
		if err := rows.Scan(&row.task.ID, &row.task.Title, &enabled, &row.task.At, &row.task.Cron, &row.task.TZ,
			&row.task.Content, &row.task.ChatID, &row.task.Mention, &row.task.LLMProfile, &row.task.WorkspaceDir, &bashEnv,
			&row.createdAt, &row.updatedAt, &row.lastRunAt, &row.task.LastRunStatus); err != nil {
			return nil, imported, err
		}
		if enabled == 0 {
			off := false
			row.task.Enabled = &off
		}
		if err := decodeBashEnv(bashEnv, &row.task); err != nil {
			return nil, imported, err
		}
		out = append(out, row)
	}
	return out, imported, rows.Err()
}

// readYAMLJobs reads cron.yaml at path for the import, after the jobs already taken from
// agent.db. It reports whether the file is there. A file that does not parse, or any record that
// has no ID, repeats one or does not validate, fails the import with an *ImportError.
func readYAMLJobs(path string, before []legacyRow) ([]Task, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, fmt.Errorf("read %s: %w", path, err)
	}
	file, err := ParseFile(string(raw))
	if err != nil {
		return nil, true, &ImportError{Path: path, Parse: err.Error()}
	}
	seen := map[string]bool{}
	for _, row := range before {
		seen[strings.TrimSpace(row.task.ID)] = true
	}
	var rejects []ImportReject
	tasks := make([]Task, 0, len(file.Tasks))
	for i, task := range file.Tasks {
		task.ID = strings.TrimSpace(task.ID)
		var reason string
		switch {
		case task.ID == "":
			reason = "task id is missing"
		case seen[task.ID]:
			reason = "duplicate task id"
		default:
			if err := ValidateTask(task); err != nil {
				reason = err.Error()
			}
		}
		if task.ID != "" {
			seen[task.ID] = true
		}
		if reason != "" {
			rejects = append(rejects, ImportReject{Record: i + 1, ID: task.ID, Error: reason})
			continue
		}
		tasks = append(tasks, task)
	}
	if len(rejects) > 0 {
		return nil, true, &ImportError{Path: path, Rejects: rejects}
	}
	return tasks, true, nil
}

// insertJob writes one job at position, with the times it had.
func insertJob(ctx context.Context, tx *sql.Tx, position int, task Task, createdAt, updatedAt string, lastRunAt sql.NullString) error {
	bashEnv, err := encodeBashEnv(task.BashEnv)
	if err != nil {
		return err
	}
	var lastRun any
	if lastRunAt.Valid {
		lastRun = lastRunAt.String
	}
	if strings.TrimSpace(createdAt) == "" {
		createdAt = nowText()
	}
	if strings.TrimSpace(updatedAt) == "" {
		updatedAt = createdAt
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO jobs (id, position, title, enabled, at, cron, tz, content, chat_id,
		mention, llm_profile, workspace_dir, bash_env, created_at, updated_at, last_run_at, last_run_status)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		strings.TrimSpace(task.ID), position, normalizeTaskTitle(task.Title), boolInt(TaskEnabled(task)),
		strings.TrimSpace(task.At), strings.TrimSpace(task.Cron), strings.TrimSpace(task.TZ), strings.TrimSpace(task.Content),
		strings.TrimSpace(task.ChatID), strings.TrimSpace(task.Mention), strings.TrimSpace(task.LLMProfile),
		strings.TrimSpace(task.WorkspaceDir), bashEnv, createdAt, updatedAt, lastRun, strings.TrimSpace(task.LastRunStatus))
	return err
}

// ImportStatus says what the one-time import into a jobs.db did.
type ImportStatus struct {
	Imported    bool   `json:"imported"`
	At          string `json:"at,omitempty"`
	Source      string `json:"source,omitempty"`
	Jobs        int    `json:"jobs"`
	IgnoredYAML bool   `json:"ignored_yaml,omitempty"`
}
