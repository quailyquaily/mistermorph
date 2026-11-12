package cron

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

type SemanticResolver interface {
	MatchTaskIndex(ctx context.Context, query string, tasks []Task) (int, error)
}

// Store is the TODO list, the cron_tasks rows of agent.db. Path names cron.yaml, which the list
// was; agent.db is in the same folder, and the file is imported from there the first time the
// database opens. Each change is one transaction; the list's order is the rows' position.
type Store struct {
	Path      string
	Semantics SemanticResolver

	db *agentdb.Lazy
}

func NewStore(path string) *Store {
	path = pathutil.ExpandHomePath(strings.TrimSpace(path))
	store := &Store{Path: path}
	if path != "" {
		store.db = agentdb.CachedBeside(path)
	}
	return store
}

func (s *Store) handle(ctx context.Context) (*agentdb.DB, error) {
	if s == nil || strings.TrimSpace(s.Path) == "" || s.db == nil {
		return nil, fmt.Errorf("cron path is not configured")
	}
	return s.db.Get(ctx)
}

// Read returns the list in order. It reports exists as true: the list is always there, empty or
// not.
func (s *Store) Read() (File, bool, error) {
	db, err := s.handle(context.Background())
	if err != nil {
		return File{}, false, err
	}
	tasks, err := readTasks(context.Background(), db)
	if err != nil {
		return File{}, true, err
	}
	return File{Version: Version, Tasks: tasks}, true, nil
}

type rowsQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

func readTasks(ctx context.Context, q rowsQueryer) ([]Task, error) {
	rows, err := q.QueryContext(ctx, `SELECT id, title, enabled, at, cron, tz, content, chat_id, mention, llm_profile,
		workspace_dir, bash_env, last_run_at, last_run_status FROM cron_tasks ORDER BY position, id`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	tasks := []Task{}
	for rows.Next() {
		var task Task
		var enabled int
		var bashEnv string
		var lastRun sql.NullString
		if err := rows.Scan(&task.ID, &task.Title, &enabled, &task.At, &task.Cron, &task.TZ, &task.Content, &task.ChatID,
			&task.Mention, &task.LLMProfile, &task.WorkspaceDir, &bashEnv, &lastRun, &task.LastRunStatus); err != nil {
			return nil, err
		}
		if enabled == 0 {
			off := false
			task.Enabled = &off
		}
		if bashEnv != "" && bashEnv != "[]" {
			if err := json.Unmarshal([]byte(bashEnv), &task.BashEnv); err != nil {
				return nil, fmt.Errorf("task %s bash_env: %w", task.ID, err)
			}
		}
		task.LastRunAt = lastRun.String
		task.Title = normalizeTaskTitle(task.Title)
		tasks = append(tasks, task)
	}
	return tasks, rows.Err()
}

// Write replaces the list with file's tasks, in their order, in one transaction. The list is
// validated first, as cron.yaml was. A task keeps its created_at and its last run.
func (s *Store) Write(file File) error {
	return s.mutate(context.Background(), func(ctx context.Context, tx *sql.Tx, _ []Task) error {
		return writeTasks(ctx, tx, file)
	})
}

func writeTasks(ctx context.Context, tx *sql.Tx, file File) error {
	if file.Version == 0 {
		file.Version = Version
	}
	if file.Tasks == nil {
		file.Tasks = []Task{}
	}
	for i := range file.Tasks {
		file.Tasks[i].Title = normalizeTaskTitle(file.Tasks[i].Title)
	}
	if err := ValidateFile(file); err != nil {
		return err
	}
	type kept struct {
		createdAt, lastRunStatus string
		lastRunAt                sql.NullString
	}
	existing := map[string]kept{}
	rows, err := tx.QueryContext(ctx, `SELECT id, created_at, last_run_at, last_run_status FROM cron_tasks`)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id string
		var k kept
		if err := rows.Scan(&id, &k.createdAt, &k.lastRunAt, &k.lastRunStatus); err != nil {
			_ = rows.Close()
			return err
		}
		existing[id] = k
	}
	if err := rows.Close(); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM cron_tasks`); err != nil {
		return err
	}
	now := agentdb.Now()
	for i, task := range file.Tasks {
		bashEnv := "[]"
		if len(task.BashEnv) > 0 {
			data, err := json.Marshal(task.BashEnv)
			if err != nil {
				return err
			}
			bashEnv = string(data)
		}
		id := strings.TrimSpace(task.ID)
		k, had := existing[id]
		createdAt := now
		var lastRunAt any
		lastRunStatus := ""
		if had {
			createdAt = k.createdAt
			if k.lastRunAt.Valid {
				lastRunAt = k.lastRunAt.String
			}
			lastRunStatus = k.lastRunStatus
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO cron_tasks (id, position, title, enabled, at, cron, tz, content, chat_id,
			mention, llm_profile, workspace_dir, bash_env, created_at, updated_at, last_run_at, last_run_status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			id, i, task.Title, agentdb.Bool(TaskEnabled(task)), strings.TrimSpace(task.At), strings.TrimSpace(task.Cron),
			strings.TrimSpace(task.TZ), strings.TrimSpace(task.Content), strings.TrimSpace(task.ChatID),
			strings.TrimSpace(task.Mention), strings.TrimSpace(task.LLMProfile), strings.TrimSpace(task.WorkspaceDir),
			bashEnv, createdAt, now, lastRunAt, lastRunStatus); err != nil {
			return fmt.Errorf("save task %s: %w", id, err)
		}
	}
	return nil
}

// mutate runs fn on the current list in one transaction.
func (s *Store) mutate(ctx context.Context, fn func(context.Context, *sql.Tx, []Task) error) error {
	db, err := s.handle(ctx)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	tasks, err := readTasks(ctx, tx)
	if err != nil {
		return err
	}
	if err := fn(ctx, tx, tasks); err != nil {
		return err
	}
	return tx.Commit()
}

// RecordRunStart notes that the scheduler started the task now. A task that is not stored (the
// heartbeat) is ignored.
func (s *Store) RecordRunStart(id string, at time.Time) error {
	db, err := s.handle(context.Background())
	if err != nil {
		return err
	}
	_, err = db.ExecContext(context.Background(), `UPDATE cron_tasks SET last_run_at = ?, last_run_status = '' WHERE id = ?`,
		agentdb.FormatTime(at), strings.TrimSpace(id))
	return err
}

// RecordRunResult notes how the task's last run ended: RunStatusDone, RunStatusFailed or
// RunStatusCanceled.
func (s *Store) RecordRunResult(id string, status string) error {
	db, err := s.handle(context.Background())
	if err != nil {
		return err
	}
	_, err = db.ExecContext(context.Background(), `UPDATE cron_tasks SET last_run_status = ? WHERE id = ?`,
		strings.TrimSpace(status), strings.TrimSpace(id))
	return err
}

func (s *Store) AddOnceWithChatID(title, content, at, tz, id, chatID string) (AddResult, error) {
	return s.AddOnce(Task{Title: title, Content: content, At: at, TZ: tz, ID: id, ChatID: chatID})
}

func (s *Store) AddRecurringWithChatID(title, content, expr, tz, id, chatID string) (AddResult, error) {
	return s.AddRecurring(Task{Title: title, Content: content, Cron: expr, TZ: tz, ID: id, ChatID: chatID})
}

// AddOnce adds a one-time task. Only the one-time fields of task are kept, its bash_env among
// them.
func (s *Store) AddOnce(task Task) (AddResult, error) {
	return s.addTask("add_once", Task{
		ID:           normalizeTaskID(task.ID),
		Title:        normalizeTaskTitle(task.Title),
		At:           strings.TrimSpace(task.At),
		TZ:           strings.TrimSpace(task.TZ),
		Content:      strings.TrimSpace(task.Content),
		ChatID:       strings.TrimSpace(task.ChatID),
		WorkspaceDir: strings.TrimSpace(task.WorkspaceDir),
		BashEnv:      normalizeBashEnvRefs(task.BashEnv),
	})
}

// AddRecurring adds a recurring task. Only the recurring fields of task are kept, its bash_env
// among them.
func (s *Store) AddRecurring(task Task) (AddResult, error) {
	return s.addTask("add_recurring", Task{
		ID:           normalizeTaskID(task.ID),
		Title:        normalizeTaskTitle(task.Title),
		Cron:         strings.TrimSpace(task.Cron),
		TZ:           strings.TrimSpace(task.TZ),
		Content:      strings.TrimSpace(task.Content),
		ChatID:       strings.TrimSpace(task.ChatID),
		WorkspaceDir: strings.TrimSpace(task.WorkspaceDir),
		BashEnv:      normalizeBashEnvRefs(task.BashEnv),
	})
}

func (s *Store) addTask(action string, task Task) (AddResult, error) {
	var result AddResult
	err := s.mutate(context.Background(), func(ctx context.Context, tx *sql.Tx, tasks []Task) error {
		if err := ValidateTask(task); err != nil {
			return err
		}
		for _, existing := range tasks {
			if strings.TrimSpace(existing.ID) == strings.TrimSpace(task.ID) {
				return fmt.Errorf("duplicate task id: %s", strings.TrimSpace(task.ID))
			}
		}
		tasks = append(tasks, task)
		if err := writeTasks(ctx, tx, File{Version: Version, Tasks: tasks}); err != nil {
			return err
		}
		result = AddResult{
			OK:        true,
			Action:    action,
			TaskCount: len(tasks),
			Task:      &task,
		}
		return nil
	})
	return result, err
}

// ErrTaskNotFound is an update of an id the list does not have.
var ErrTaskNotFound = errors.New("no TODO task with that id")

// Update changes the task id in place, in one transaction: only the fields patch sets are
// written, and every other field, the id, the task's position and its last run stay as they
// were. Setting at alone makes the task one-time (its cron is cleared) and setting cron alone
// makes it recurring (its at is cleared). The changed task is validated as a whole first; an
// unknown id, an empty patch or a task that does not validate changes nothing.
func (s *Store) Update(ctx context.Context, id string, patch TaskPatch) (UpdateResult, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return UpdateResult{}, fmt.Errorf("id is required")
	}
	if patch.IsEmpty() {
		return UpdateResult{}, fmt.Errorf("update needs at least one field to change")
	}
	var result UpdateResult
	err := s.mutate(ctx, func(ctx context.Context, tx *sql.Tx, tasks []Task) error {
		idx := -1
		for i, task := range tasks {
			if strings.TrimSpace(task.ID) == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("%w: %s", ErrTaskNotFound, id)
		}
		updated, fields := patch.apply(tasks[idx])
		if err := ValidateTask(updated); err != nil {
			return err
		}
		tasks[idx] = updated
		if err := writeTasks(ctx, tx, File{Version: Version, Tasks: tasks}); err != nil {
			return err
		}
		result = UpdateResult{OK: true, Action: "update", TaskCount: len(tasks), Task: &updated, Fields: fields}
		return nil
	})
	return result, err
}

func (s *Store) Delete(ctx context.Context, id, content string) (DeleteResult, error) {
	id = strings.TrimSpace(id)
	if id != "" {
		return s.deleteByID(ctx, id)
	}
	query := strings.TrimSpace(content)
	if query == "" {
		return DeleteResult{}, fmt.Errorf("id or content is required")
	}
	// The model picks the task from the list as it is now, outside any transaction: holding the
	// write lock while it answers would stall every other writer of agent.db. The pick is then
	// deleted by id, from the list as it is when the delete commits, and only if it is still the
	// task the model saw.
	file, _, err := s.Read()
	if err != nil {
		return DeleteResult{}, err
	}
	tasks := file.Tasks
	if len(tasks) == 0 {
		return DeleteResult{}, fmt.Errorf("no matching TODO task")
	}
	if s.Semantics == nil {
		return DeleteResult{}, fmt.Errorf("cron semantic resolver is required")
	}
	idx, err := s.Semantics.MatchTaskIndex(ctx, query, tasks)
	if err != nil {
		return DeleteResult{}, err
	}
	if idx < 0 || idx >= len(tasks) {
		return DeleteResult{}, fmt.Errorf("no matching TODO task")
	}
	matched := tasks[idx]
	var result DeleteResult
	err = s.mutate(ctx, func(ctx context.Context, tx *sql.Tx, tasks []Task) error {
		idx := -1
		for i, task := range tasks {
			if strings.TrimSpace(task.ID) == strings.TrimSpace(matched.ID) {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("%w: %s was deleted while the model matched it", ErrTaskChanged, matched.ID)
		}
		if !sameTaskDefinition(tasks[idx], matched) {
			return fmt.Errorf("%w: %s was edited while the model matched it", ErrTaskChanged, matched.ID)
		}
		deleted := tasks[idx]
		tasks = append(tasks[:idx], tasks[idx+1:]...)
		if err := writeTasks(ctx, tx, File{Version: Version, Tasks: tasks}); err != nil {
			return err
		}
		result = DeleteResult{OK: true, Action: "delete", TaskCount: len(tasks), Deleted: &deleted}
		return nil
	})
	return result, err
}

// ErrTaskChanged is a semantic delete whose matched task was deleted or edited while the model
// was matching it. Nothing is deleted; matching again sees the list as it is now.
var ErrTaskChanged = errors.New("the matched TODO task changed; nothing was deleted, try again")

// sameTaskDefinition reports whether a and b are the same task as clients wrote it. The last run,
// which the scheduler records on its own, does not count.
func sameTaskDefinition(a, b Task) bool {
	a.LastRunAt, a.LastRunStatus = "", ""
	b.LastRunAt, b.LastRunStatus = "", ""
	return reflect.DeepEqual(a, b)
}

func (s *Store) DeleteByID(id string) (DeleteResult, error) {
	return s.deleteByID(context.Background(), id)
}

func (s *Store) deleteByID(ctx context.Context, id string) (DeleteResult, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return DeleteResult{}, fmt.Errorf("id is required")
	}
	var result DeleteResult
	err := s.mutate(ctx, func(ctx context.Context, tx *sql.Tx, tasks []Task) error {
		idx := -1
		for i, task := range tasks {
			if strings.TrimSpace(task.ID) == id {
				idx = i
				break
			}
		}
		if idx < 0 {
			return fmt.Errorf("no matching TODO task")
		}
		deleted := tasks[idx]
		tasks = append(tasks[:idx], tasks[idx+1:]...)
		if err := writeTasks(ctx, tx, File{Version: Version, Tasks: tasks}); err != nil {
			return err
		}
		result = DeleteResult{OK: true, Action: "delete", TaskCount: len(tasks), Deleted: &deleted}
		return nil
	})
	return result, err
}

func (s *Store) FindByID(id string) (Task, bool, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return Task{}, false, fmt.Errorf("id is required")
	}
	file, _, err := s.Read()
	if err != nil {
		return Task{}, false, err
	}
	for _, task := range file.Tasks {
		if strings.TrimSpace(task.ID) == id {
			return task, true, nil
		}
	}
	return Task{}, false, nil
}

func (s *Store) DueLenient(now time.Time) ([]DueTask, []error, error) {
	file, _, err := s.Read()
	if err != nil {
		return nil, nil, err
	}
	now = now.UTC()
	out := make([]DueTask, 0, len(file.Tasks))
	var taskErrs []error
	seen := map[string]bool{}
	for _, task := range file.Tasks {
		id := strings.TrimSpace(task.ID)
		if seen[id] {
			taskErrs = append(taskErrs, fmt.Errorf("duplicate task id: %s", id))
			continue
		}
		seen[id] = true
		if !TaskEnabled(task) {
			continue
		}
		if err := ValidateTask(task); err != nil {
			taskErrs = append(taskErrs, err)
			continue
		}
		due, scheduledAt, err := IsDue(task, now)
		if err != nil {
			taskErrs = append(taskErrs, err)
			continue
		}
		if due && !stoppedOnceAfter(task, scheduledAt) {
			out = append(out, DueTask{Task: task, ScheduledAtUTC: scheduledAt})
		}
	}
	return out, taskErrs, nil
}

// stoppedOnceAfter reports whether a one-time task's run at or after its time scheduledAt was
// stopped by a person. That was its one execution, so the past time does not fire it again (a
// failed one does); the task is kept as it is, and a new time or a manual run runs it again.
func stoppedOnceAfter(task Task, scheduledAt time.Time) bool {
	if strings.TrimSpace(task.At) == "" || strings.TrimSpace(task.LastRunStatus) != RunStatusCanceled {
		return false
	}
	last, err := time.Parse(time.RFC3339, strings.TrimSpace(task.LastRunAt))
	return err == nil && !last.Before(scheduledAt)
}

// SchedulerLockFilename is the lock one process holds while it schedules the TODO list, in the
// state folder's locks folder.
const SchedulerLockFilename = "cron.scheduler.lck"

// SchedulerLockPath is the scheduler's lock for the list whose cron.yaml path is path:
// <state>/locks/cron.scheduler.lck. It stays a file lock: a process holds it for its lifetime, and
// the kernel releases it when the process dies.
func SchedulerLockPath(path string) (string, error) {
	path = pathutil.ExpandHomePath(strings.TrimSpace(path))
	if path == "" {
		return "", fmt.Errorf("cron path is not configured")
	}
	return filepath.Join(filepath.Dir(path), "locks", SchedulerLockFilename), nil
}

func normalizeTaskID(raw string) string {
	id := strings.TrimSpace(raw)
	if id != "" {
		return id
	}
	return "cron-" + uuid.NewString()
}
