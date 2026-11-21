package cron

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"
)

// Run statuses a run has before it ends, and the one of a run that was never started.
const (
	RunStatusQueued  = "queued"
	RunStatusRunning = "running"
	// RunStatusSkipped is a run recorded instead of started: the job that would have started it
	// failed, the job is switched off, or the chain was too deep. Its cause's note says which.
	RunStatusSkipped = "skipped"
)

const (
	// RunHistoryKeptPerJob is how many runs the history keeps for one job: the newest.
	RunHistoryKeptPerJob = 200
	// RunHistoryMaxAge is how long a run stays in the history at most.
	RunHistoryMaxAge = 180 * 24 * time.Hour
	// StaleRunAfter is how long a run may stay queued or running before a starting loop takes it
	// as left behind by a runtime that stopped without ending it.
	StaleRunAfter = 24 * time.Hour
	// RunHistoryDefaultLimit and RunHistoryMaxLimit bound one read of the history.
	RunHistoryDefaultLimit = 50
	RunHistoryMaxLimit     = 500

	// MaxChainDepth is how many jobs deep a chain of jobs may go, the run that starts it counted.
	MaxChainDepth = 5

	// QueueFullNote is the note of a run skipped because the loop's queue had no room.
	QueueFullNote = "the run queue was full"

	runErrorMaxLen = 300
	staleRunError  = "the runtime stopped before this run ended"
)

// RunRecord is one run of a job in the history. Times are RFC 3339 in UTC; StartedAt and
// FinishedAt are empty until the run starts and ends. A skipped run has no StartedAt.
type RunRecord struct {
	RunID      string   `json:"run_id"`
	JobID      string   `json:"job_id"`
	Status     string   `json:"status"`
	QueuedAt   string   `json:"queued_at"`
	StartedAt  string   `json:"started_at,omitempty"`
	FinishedAt string   `json:"finished_at,omitempty"`
	Error      string   `json:"error,omitempty"`
	Cause      RunCause `json:"cause"`
	// TaskID is the ID of the task record the run wrote under its job's topic, which keeps the
	// run's output; empty for a run that never started.
	TaskID string `json:"task_id,omitempty"`
	// ChainDepth is the run's place in its chain of jobs, from 1.
	ChainDepth int `json:"-"`
}

// RunHistoryQuery selects runs from the history. JobID, when set, keeps one job's runs; From and
// To, when set, keep the runs queued at or after From and before To. Limit bounds the answer
// (RunHistoryDefaultLimit when 0, at most RunHistoryMaxLimit).
type RunHistoryQuery struct {
	JobID string
	From  time.Time
	To    time.Time
	Limit int
}

// RecordRun adds a run to the history, in whatever status it has: queued for one a loop will
// start, skipped for one that is only recorded. A run without a run ID gets one, and one without
// an origin is its own. The history is then trimmed (see RunHistoryKeptPerJob).
func (s *Store) RecordRun(ctx context.Context, run RunRecord) (RunRecord, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return run, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	run.RunID, run.JobID = strings.TrimSpace(run.RunID), strings.TrimSpace(run.JobID)
	if run.JobID == "" {
		return run, fmt.Errorf("job id is required")
	}
	if run.RunID == "" {
		run.RunID = NewRunID()
	}
	if strings.TrimSpace(run.Status) == "" {
		run.Status = RunStatusQueued
	}
	if strings.TrimSpace(run.QueuedAt) == "" {
		run.QueuedAt = nowText()
	}
	if strings.TrimSpace(run.Cause.Kind) == "" {
		run.Cause.Kind = CauseSchedule
	}
	if strings.TrimSpace(run.Cause.OriginRunID) == "" {
		run.Cause.OriginRunID = run.RunID
	}
	if run.ChainDepth < 1 {
		run.ChainDepth = 1
	}
	run.Error = shortRunError(run.Error)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return run, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO job_runs (run_id, job_id, status, queued_at, started_at, finished_at, error,
		cause_kind, trigger_id, from_job_id, origin_run_id, note, chain_depth) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		run.RunID, run.JobID, run.Status, run.QueuedAt, nullText(run.StartedAt), nullText(run.FinishedAt), run.Error,
		run.Cause.Kind, run.Cause.TriggerID, run.Cause.FromJobID, run.Cause.OriginRunID, run.Cause.Note, run.ChainDepth); err != nil {
		return run, err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM job_runs WHERE job_id = ? AND seq NOT IN
		(SELECT seq FROM job_runs WHERE job_id = ? ORDER BY seq DESC LIMIT ?)`, run.JobID, run.JobID, RunHistoryKeptPerJob); err != nil {
		return run, err
	}
	// Age is counted from this run, so the history follows the clock its writer runs by.
	if queuedAt, err := time.Parse(time.RFC3339, run.QueuedAt); err == nil {
		if _, err := tx.ExecContext(ctx, `DELETE FROM job_runs WHERE queued_at < ?`, formatTime(queuedAt.Add(-RunHistoryMaxAge))); err != nil {
			return run, err
		}
	}
	return run, tx.Commit()
}

// RunTime is t as the history keeps times: RFC 3339 in UTC, to the second; "" for the zero time.
func RunTime(t time.Time) string {
	return formatTime(t)
}

// MarkRunStarted notes in the history that the run started at at.
func (s *Store) MarkRunStarted(ctx context.Context, runID string, at time.Time) error {
	db, err := s.handle(ctx)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `UPDATE job_runs SET status = ?, started_at = ? WHERE run_id = ?`,
		RunStatusRunning, formatTime(at), strings.TrimSpace(runID))
	return err
}

// MarkRunFinished notes in the history how the run ended at at: status is RunStatusDone,
// RunStatusFailed, RunStatusCanceled or RunStatusSkipped, and errText a short reason for a run
// that did not end done. note, when set, replaces the cause's note.
func (s *Store) MarkRunFinished(ctx context.Context, runID, status, errText, note string, at time.Time) error {
	db, err := s.handle(ctx)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `UPDATE job_runs SET status = ?, finished_at = ?, error = ?,
		note = CASE WHEN ? <> '' THEN ? ELSE note END WHERE run_id = ?`,
		strings.TrimSpace(status), formatTime(at), shortRunError(errText), note, note, strings.TrimSpace(runID))
	return err
}

// SetRunTaskID notes in the history the task record the run writes under its job's topic.
func (s *Store) SetRunTaskID(ctx context.Context, runID, taskID string) error {
	runID, taskID = strings.TrimSpace(runID), strings.TrimSpace(taskID)
	if runID == "" || taskID == "" {
		return nil
	}
	db, err := s.handle(ctx)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `UPDATE job_runs SET task_id = ? WHERE run_id = ?`, taskID, runID)
	return err
}

// LatestRun returns the newest run of job jobID in the history that has one of statuses (any
// status without them).
func (s *Store) LatestRun(ctx context.Context, jobID string, statuses ...string) (RunRecord, bool, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return RunRecord{}, false, err
	}
	where := "WHERE job_id = ?"
	args := []any{strings.TrimSpace(jobID)}
	if len(statuses) > 0 {
		marks := make([]string, 0, len(statuses))
		for _, status := range statuses {
			marks = append(marks, "?")
			args = append(args, status)
		}
		where += " AND status IN (" + strings.Join(marks, ", ") + ")"
	}
	runs, err := queryRuns(ctx, db, where+` ORDER BY seq DESC LIMIT 1`, args...)
	if err != nil || len(runs) == 0 {
		return RunRecord{}, false, err
	}
	return runs[0], true, nil
}

// FailStaleRuns ends, as failed, the runs still queued or running that were queued before before:
// a runtime that stopped without ending them left them so. It returns how many.
func (s *Store) FailStaleRuns(ctx context.Context, before time.Time) (int64, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return 0, err
	}
	result, err := db.ExecContext(ctx, `UPDATE job_runs SET status = ?, finished_at = ?, error = ?
		WHERE status IN (?, ?) AND queued_at < ?`,
		RunStatusFailed, nowText(), staleRunError, RunStatusQueued, RunStatusRunning, formatTime(before))
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// RunHistory lists runs from the history, newest first.
func (s *Store) RunHistory(ctx context.Context, query RunHistoryQuery) ([]RunRecord, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return nil, err
	}
	limit := query.Limit
	if limit <= 0 {
		limit = RunHistoryDefaultLimit
	}
	if limit > RunHistoryMaxLimit {
		limit = RunHistoryMaxLimit
	}
	where := []string{"1 = 1"}
	var args []any
	if id := strings.TrimSpace(query.JobID); id != "" {
		where = append(where, "job_id = ?")
		args = append(args, id)
	}
	if !query.From.IsZero() {
		where = append(where, "queued_at >= ?")
		args = append(args, formatTime(query.From))
	}
	if !query.To.IsZero() {
		where = append(where, "queued_at < ?")
		args = append(args, formatTime(query.To))
	}
	args = append(args, limit)
	return queryRuns(ctx, db, `WHERE `+strings.Join(where, " AND ")+` ORDER BY queued_at DESC, seq DESC LIMIT ?`, args...)
}

// ChainRuns lists the runs of the chain the run originRunID started, oldest first.
func (s *Store) ChainRuns(ctx context.Context, originRunID string) ([]RunRecord, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return nil, err
	}
	originRunID = strings.TrimSpace(originRunID)
	if originRunID == "" {
		return []RunRecord{}, nil
	}
	return queryRuns(ctx, db, `WHERE origin_run_id = ? ORDER BY seq`, originRunID)
}

func queryRuns(ctx context.Context, q rowsQueryer, tail string, args ...any) ([]RunRecord, error) {
	rows, err := q.QueryContext(ctx, `SELECT run_id, job_id, status, queued_at, started_at, finished_at, error,
		cause_kind, trigger_id, from_job_id, origin_run_id, note, chain_depth, task_id FROM job_runs `+tail, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := []RunRecord{}
	for rows.Next() {
		var run RunRecord
		var startedAt, finishedAt sql.NullString
		if err := rows.Scan(&run.RunID, &run.JobID, &run.Status, &run.QueuedAt, &startedAt, &finishedAt, &run.Error,
			&run.Cause.Kind, &run.Cause.TriggerID, &run.Cause.FromJobID, &run.Cause.OriginRunID, &run.Cause.Note, &run.ChainDepth, &run.TaskID); err != nil {
			return nil, err
		}
		run.StartedAt, run.FinishedAt = startedAt.String, finishedAt.String
		out = append(out, run)
	}
	return out, rows.Err()
}

func nullText(value string) any {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return nil
}

// shortRunError keeps the first line of an error, cut to a length a list can show.
func shortRunError(text string) string {
	text = strings.TrimSpace(text)
	if cut := strings.IndexAny(text, "\r\n"); cut >= 0 {
		text = strings.TrimSpace(text[:cut])
	}
	if len(text) <= runErrorMaxLen {
		return text
	}
	cut := runErrorMaxLen
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut] + "…"
}

// OnceRetryDelays is how long a one-time ("at") schedule waits before each new try after a run it
// started failed: the first retry a minute after the first failure, and so on. After the last
// one fails too, the schedule is not tried again.
var OnceRetryDelays = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour}

// OnceRetry is where a one-time schedule stands after failed runs.
type OnceRetry struct {
	// Failures is how many runs the schedule started, at or after its time, that failed or were
	// skipped (an input it needed fresh did not finish). A run dropped for a full queue is not
	// one.
	Failures int
	// LastFailedAt is when the last of them ended.
	LastFailedAt time.Time
}

// GaveUp reports whether every try was used: the schedule fires no more.
func (r OnceRetry) GaveUp() bool { return r.Failures > len(OnceRetryDelays) }

// NextAt is the earliest time of the next try; zero when there was no failure or none is left.
func (r OnceRetry) NextAt() time.Time {
	if r.Failures < 1 || r.GaveUp() {
		return time.Time{}
	}
	return r.LastFailedAt.Add(OnceRetryDelays[r.Failures-1])
}

// OnceRetryState counts the failed tries of the one-time trigger triggerID of job jobID whose
// time was scheduledAt. Runs queued before that time are of an earlier setting of the trigger and
// do not count, so a new time starts afresh; a run a person, a poke or another job started is
// never counted.
func (s *Store) OnceRetryState(ctx context.Context, jobID, triggerID string, scheduledAt time.Time) (OnceRetry, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return OnceRetry{}, err
	}
	if ctx == nil {
		ctx = context.Background()
	}
	var retry OnceRetry
	var last sql.NullString
	err = db.QueryRowContext(ctx, `SELECT count(*), max(finished_at) FROM job_runs
		WHERE job_id = ? AND trigger_id = ? AND cause_kind = ? AND status IN (?, ?) AND note <> ? AND queued_at >= ?`,
		strings.TrimSpace(jobID), strings.TrimSpace(triggerID), CauseSchedule, RunStatusFailed, RunStatusSkipped,
		QueueFullNote, formatTime(scheduledAt)).Scan(&retry.Failures, &last)
	if err != nil {
		return OnceRetry{}, err
	}
	if last.Valid {
		retry.LastFailedAt, _ = time.Parse(time.RFC3339, last.String)
	}
	return retry, nil
}

// onceHeldBack reports whether the one-time trigger, due since scheduledAt, must not fire at now:
// a run it started failed and the wait before the next try is not over, or no try is left. The
// history is read only for a job whose last run did not end done.
func (s *Store) onceHeldBack(task Task, trigger Trigger, scheduledAt, now time.Time) bool {
	if strings.TrimSpace(trigger.At) == "" || strings.TrimSpace(task.LastRunAt) == "" {
		return false
	}
	retry, err := s.OnceRetryState(context.Background(), task.ID, trigger.ID, scheduledAt)
	if err != nil || retry.Failures == 0 {
		return false
	}
	return retry.GaveUp() || now.Before(retry.NextAt())
}
