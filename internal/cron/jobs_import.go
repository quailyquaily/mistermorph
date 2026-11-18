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
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
	"gopkg.in/yaml.v3"
)

// The job list (the TODO list) is the jobs table of agent.db, in the state folder. The scheduler,
// the Console and the tools all open it, from one process or several; SQLite's WAL and IMMEDIATE
// transactions keep their changes whole, and every read sees what the others committed.
//
// The first time the job store opens an agent.db, it imports the lists that came before, once, in
// one transaction that also sets the import mark (meta imported:jobs). From then on no earlier
// store is read again, so a job deleted here never comes back. The earlier stores are only read:
//
//   - jobs.db, the job store of an earlier build. It is the newest of them: its jobs come first,
//     as they are, in their order.
//   - agent.db's cron_tasks rows, where versions before kept the list (imported:cron marks that
//     they had imported cron.yaml). When there is no jobs.db they are the list. Beside a jobs.db,
//     only what jobs.db cannot already have is added (see mergeJobStores): rows made after jobs.db
//     took the list over, by an older version run since. A row jobs.db took over and then deleted
//     or changed is not brought back. A row that the older version changed after jobs.db took
//     over, and that jobs.db deleted or holds differently, cannot be reconciled: it is rejected
//     (not imported, and listed in meta under import_rejects:jobs), and jobs.db's version stays.
//   - cron.yaml, only when no database has taken the list over yet (neither mark is set). It is
//     never renamed or changed. A cron.yaml that does not import whole (it does not parse, or a
//     record has no ID, repeats one, does not validate or collides with a job already listed)
//     imports nothing: the open fails with an *ImportError naming every rejected record, and the
//     next open tries again.
//
// An import that fails for any reason rolls back whole and runs again on the next open. The job
// store's import runs apart from agent.db's own imports, so a cron.yaml that does not import
// stops only the job list, not the rest of agent.db.

// JobsDBFilename is the job store of an earlier build: a database of its own in the state folder,
// which the import reads once and leaves in place.
const JobsDBFilename = statepaths.JobsDBFilename

const (
	// jobsImportStore names the import in agent.db's meta table: imported:jobs, and
	// import_rejects:jobs for the records it could not reconcile.
	jobsImportStore = "jobs"
	// jobsImportDetailKey is the meta key of what the import found (importMark).
	jobsImportDetailKey = "jobs_import"
	// jobsRevisionKey is the meta key of the list's revision: it counts the changes to the jobs
	// themselves (not the runs the scheduler records), so a client can save only what it read.
	jobsRevisionKey = "jobs_revision"
	// legacyAgentDBImportMark is the mark agent.db holds once an earlier version imported
	// cron.yaml into its cron_tasks table.
	legacyAgentDBImportMark = "imported:cron"
	// legacyJobsDBImportMark is the mark jobs.db holds once it took the list over.
	legacyJobsDBImportMark = "imported:jobs"
)

// Sources of the import, as importMark.Source and the rejects name them.
const (
	sourceJobsDB    = statepaths.JobsDBFilename
	sourceCronTasks = statepaths.AgentDBFilename + " cron_tasks"
	sourceCronYAML  = DefaultFilename
)

var jobsImporter = agentdb.Importer{Name: jobsImportStore, Run: importJobs}

// importedPools are the agent.db connection pools whose job import is known to be done.
var importedPools sync.Map

// ensureJobsImported runs the job import into db unless it has run.
func ensureJobsImported(ctx context.Context, db *agentdb.DB) error {
	if _, done := importedPools.Load(db.DB); done {
		return nil
	}
	if _, err := agentdb.RunImport(ctx, db, jobsImporter); err != nil {
		return err
	}
	importedPools.Store(db.DB, struct{}{})
	return nil
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
		e.Path, statepaths.AgentDBFilename)
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

// importMark is what agent.db's meta table holds under jobs_import.
type importMark struct {
	At string `json:"at"`
	// Source names where the jobs came from, joined by "+": "jobs.db", "agent.db cron_tasks",
	// "cron.yaml"; "" when there was nothing to import.
	Source string `json:"source,omitempty"`
	Jobs   int    `json:"jobs"`
	// Rejected counts the records that could not be reconciled (import_rejects:jobs lists them).
	Rejected int `json:"rejected,omitempty"`
	// IgnoredYAML is set when a cron.yaml was present but not read, because a database had already
	// taken the list over.
	IgnoredYAML bool `json:"ignored_yaml,omitempty"`
}

// legacyRow is a job as an earlier store kept it, with what the store recorded beside it.
type legacyRow struct {
	task      Task
	position  int
	createdAt string
	updatedAt string
	lastRunAt sql.NullString
}

// legacyJobsDB is what an earlier build's jobs.db holds.
type legacyJobsDB struct {
	// present is whether the file is there with a jobs table.
	present bool
	// tookOver is whether its import mark is set; at is when it took the list over.
	tookOver bool
	at       time.Time
	rows     []legacyRow
}

// importJobs is the job import, in agent.db's transaction tx.
func importJobs(ctx context.Context, tx *sql.Tx, env agentdb.ImportEnv) (agentdb.ImportResult, error) {
	var result agentdb.ImportResult
	jobsDB, err := readLegacyJobsDB(ctx, filepath.Join(env.StateDir, JobsDBFilename))
	if err != nil {
		return result, fmt.Errorf("read the jobs %s holds (move the file aside to import without it): %w", JobsDBFilename, err)
	}
	cronRows, cronImported, err := readCronTasks(ctx, tx)
	if err != nil {
		return result, fmt.Errorf("read the jobs agent.db cron_tasks holds: %w", err)
	}
	rows, rejects := mergeJobStores(jobsDB, cronRows)

	yamlPath := filepath.Join(env.StateDir, DefaultFilename)
	_, statErr := os.Stat(yamlPath)
	yamlPresent := statErr == nil
	yamlStale := cronImported || jobsDB.tookOver
	var yamlTasks []Task
	if !yamlStale {
		yamlTasks, yamlPresent, err = readYAMLJobs(yamlPath, rows)
		if err != nil {
			return result, err
		}
	}

	now := nowText()
	position := 0
	for _, row := range rows {
		if err := insertJob(ctx, tx, position, row.task, row.createdAt, row.updatedAt, row.lastRunAt); err != nil {
			return result, fmt.Errorf("import job %s: %w", row.task.ID, err)
		}
		position++
	}
	for _, task := range yamlTasks {
		if err := insertJob(ctx, tx, position, task, now, now, sql.NullString{}); err != nil {
			return result, fmt.Errorf("import job %s from %s: %w", task.ID, DefaultFilename, err)
		}
		position++
	}
	if position > 0 {
		if err := bumpRevision(ctx, tx); err != nil {
			return result, err
		}
	}

	var sources []string
	if jobsDB.present {
		sources = append(sources, sourceJobsDB)
	}
	if len(cronRows) > 0 || cronImported {
		sources = append(sources, sourceCronTasks)
	}
	if !yamlStale && yamlPresent {
		sources = append(sources, sourceCronYAML)
	}
	mark := importMark{At: now, Source: strings.Join(sources, "+"), Jobs: position, Rejected: len(rejects),
		IgnoredYAML: yamlStale && yamlPresent}
	if err := setMeta(ctx, tx, jobsImportDetailKey, mark); err != nil {
		return result, err
	}
	for _, reject := range rejects {
		env.Logger.Warn("jobs_import_reject", "source", reject.Source, "error", reject.Error)
	}
	result.Rejects = rejects
	return result, nil
}

// mergeJobStores is the list the two earlier databases give, and the records that could not be
// reconciled. Its rules, in order, for each cron_tasks row beside a jobs.db:
//
//  1. jobs.db holds the same job (same ID and definition): jobs.db's copy is kept, with its runs.
//  2. The row was there when jobs.db took the list over, and not changed since (its updated_at is
//     not after jobs.db's import mark): jobs.db took it, so jobs.db's version stands, or its
//     deletion of it.
//  3. The row was changed after that, by an older version run since, and jobs.db holds the ID
//     differently or deleted a job that was there: rejected; jobs.db's version (or its deletion)
//     stands.
//  4. Otherwise (it was made after jobs.db took over, or jobs.db never did): the row is added, after
//     jobs.db's jobs, unless jobs.db holds the ID differently, which rejects it.
//
// Without a jobs.db the cron_tasks rows are the list.
func mergeJobStores(jobsDB legacyJobsDB, cronRows []legacyRow) ([]legacyRow, []stateimport.Reject) {
	if !jobsDB.present {
		return cronRows, nil
	}
	rows := append([]legacyRow(nil), jobsDB.rows...)
	byID := make(map[string]legacyRow, len(rows))
	for _, row := range rows {
		byID[strings.TrimSpace(row.task.ID)] = row
	}
	var rejects []stateimport.Reject
	reject := func(row legacyRow, reason string) {
		raw, _ := yaml.Marshal(row.task)
		rejects = append(rejects, stateimport.Reject{Source: sourceCronTasks, Line: row.position + 1, Error: reason, Raw: string(raw)})
	}
	for _, row := range cronRows {
		id := strings.TrimSpace(row.task.ID)
		held, inJobsDB := byID[id]
		existed := jobsDB.tookOver && !timeAfter(row.createdAt, jobsDB.at)
		changed := !jobsDB.tookOver || timeAfter(row.updatedAt, jobsDB.at)
		switch {
		case inJobsDB && sameJobDefinition(held.task, row.task):
			continue
		case existed && !changed:
			continue
		case inJobsDB:
			reject(row, fmt.Sprintf("job %s differs from the one %s holds, and was changed in cron_tasks after %s took the list over, so which is newer cannot be told; %s's version is kept",
				id, JobsDBFilename, JobsDBFilename, JobsDBFilename))
		case existed:
			reject(row, fmt.Sprintf("job %s was deleted in %s but changed afterwards by an older version; it is not brought back",
				id, JobsDBFilename))
		default:
			rows = append(rows, row)
			byID[id] = row
		}
	}
	return rows, rejects
}

// timeAfter reports whether the stored time raw is after t. A time that does not parse is taken as
// after, so a row of unknown age is never assumed to be one jobs.db already took.
func timeAfter(raw string, t time.Time) bool {
	parsed, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(raw))
	if err != nil {
		return true
	}
	return parsed.After(t)
}

// sameJobDefinition reports whether a and b define the same job, runs aside.
func sameJobDefinition(a, b Task) bool {
	norm := func(task Task) Task {
		task.ID = strings.TrimSpace(task.ID)
		task.Title = normalizeTaskTitle(task.Title)
		enabled := TaskEnabled(task)
		task.Enabled = &enabled
		if len(task.BashEnv) == 0 {
			task.BashEnv = nil
		}
		task.LastRunAt, task.LastRunStatus = "", ""
		return task
	}
	return sameTaskDefinition(norm(a), norm(b))
}

// readCronTasks reads agent.db's cron_tasks rows in order, and whether agent.db imported cron.yaml.
func readCronTasks(ctx context.Context, tx *sql.Tx) ([]legacyRow, bool, error) {
	var n int
	if err := tx.QueryRowContext(ctx, `SELECT count(*) FROM meta WHERE key = ?`, legacyAgentDBImportMark).Scan(&n); err != nil {
		return nil, false, err
	}
	rows, err := readLegacyRows(ctx, tx, "cron_tasks")
	return rows, n > 0, err
}

// readLegacyJobsDB reads the jobs.db at path, which is only read: opened as it is, without
// migrations, and never written. A missing file, or one without a jobs table, is not present.
func readLegacyJobsDB(ctx context.Context, path string) (legacyJobsDB, error) {
	var out legacyJobsDB
	if _, err := os.Stat(path); errors.Is(err, os.ErrNotExist) {
		return out, nil
	} else if err != nil {
		return out, err
	}
	query := url.Values{}
	query.Add("_pragma", fmt.Sprintf("busy_timeout(%d)", sqlitedb.BusyTimeout.Milliseconds()))
	query.Add("_pragma", "query_only(1)")
	// Read-only: the connection never writes the file, not even a checkpoint of its -wal on close.
	query.Set("mode", "ro")
	db, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?"+query.Encode())
	if err != nil {
		return out, err
	}
	defer func() { _ = db.Close() }()
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		return out, err
	}
	defer func() { _ = conn.Close() }()
	// One read transaction, so the rows and the mark are one moment of the file.
	tx, err := conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer func() { _ = tx.Rollback() }()
	has := func(table string) (bool, error) {
		var n int
		err := tx.QueryRowContext(ctx, `SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ?`, table).Scan(&n)
		return n > 0, err
	}
	if ok, err := has("jobs"); err != nil || !ok {
		return out, err
	}
	out.present = true
	if ok, err := has("meta"); err != nil {
		return out, err
	} else if ok {
		var mark struct {
			At string `json:"at"`
		}
		found, err := getMeta(ctx, tx, legacyJobsDBImportMark, &mark)
		if err != nil {
			return out, fmt.Errorf("read its import mark: %w", err)
		}
		if found {
			at, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(mark.At))
			if err != nil {
				return out, fmt.Errorf("read its import mark: %w", err)
			}
			out.tookOver, out.at = true, at
		}
	}
	out.rows, err = readLegacyRows(ctx, tx, "jobs")
	return out, err
}

// readLegacyRows reads the job rows of table (cron_tasks or jobs, which have the same columns), in
// order.
func readLegacyRows(ctx context.Context, q rowsQueryer, table string) ([]legacyRow, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, position, title, enabled, at, cron, tz, content, chat_id, mention, llm_profile,
		workspace_dir, bash_env, created_at, updated_at, last_run_at, last_run_status FROM `+table+` ORDER BY position, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []legacyRow
	for rows.Next() {
		var row legacyRow
		var enabled int
		var bashEnv string
		if err := rows.Scan(&row.task.ID, &row.position, &row.task.Title, &enabled, &row.task.At, &row.task.Cron, &row.task.TZ,
			&row.task.Content, &row.task.ChatID, &row.task.Mention, &row.task.LLMProfile, &row.task.WorkspaceDir, &bashEnv,
			&row.createdAt, &row.updatedAt, &row.lastRunAt, &row.task.LastRunStatus); err != nil {
			return nil, err
		}
		if enabled == 0 {
			off := false
			row.task.Enabled = &off
		}
		if err := decodeBashEnv(bashEnv, &row.task); err != nil {
			return nil, err
		}
		row.task.LastRunAt = row.lastRunAt.String
		out = append(out, row)
	}
	return out, rows.Err()
}

// readYAMLJobs reads cron.yaml at path for the import, after the jobs already taken from the
// databases. It reports whether the file is there. A file that does not parse, or any record that
// has no ID, repeats one, collides with a job already taken or does not validate, fails the import
// with an *ImportError.
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

// ImportStatus says what the one-time import into agent.db's jobs table did.
type ImportStatus struct {
	Imported    bool   `json:"imported"`
	At          string `json:"at,omitempty"`
	Source      string `json:"source,omitempty"`
	Jobs        int    `json:"jobs"`
	IgnoredYAML bool   `json:"ignored_yaml,omitempty"`
	// Rejects are the records the import could not reconcile and left out.
	Rejects []stateimport.Reject `json:"rejects,omitempty"`
}
