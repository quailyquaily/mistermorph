package cron

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/pathutil"
)

// RunState is what a cron loop is doing with a task now.
type RunState string

const (
	RunQueued  RunState = "queued"
	RunRunning RunState = "running"
)

// ErrRunStopped is the cause a stopped execution's context is cancelled with.
var ErrRunStopped = errors.New("stopped by user")

// TaskRun is one execution a cron loop holds: waiting for a free slot, or running.
type TaskRun struct {
	ID string `json:"id"`
	// RunID names this execution; a later run of the same task gets another one.
	RunID     string    `json:"run_id,omitempty"`
	State     RunState  `json:"state"`
	Manual    bool      `json:"manual,omitempty"`
	QueuedAt  time.Time `json:"queued_at"`
	StartedAt time.Time `json:"started_at,omitempty"`
	// Stopping is set once someone asked to stop this execution; it is still winding down.
	Stopping bool `json:"stopping,omitempty"`

	seq uint64 // Order of queueing, for queued tasks with the same time.
}

// FinishedRun is how a recent execution ended: RunStatusDone, RunStatusFailed or
// RunStatusCanceled. Stopping is set when a stop was asked for before it ended.
type FinishedRun struct {
	ID         string    `json:"id"`
	RunID      string    `json:"run_id"`
	Status     string    `json:"status"`
	Stopping   bool      `json:"stopping,omitempty"`
	FinishedAt time.Time `json:"finished_at"`
}

// Stop outcomes (StopResult.Status besides the finished statuses).
const (
	// StopStopping: the execution was asked to stop (now or by an earlier request) and has not
	// ended yet; its end shows in the board's finished runs.
	StopStopping = "stopping"
	// StopNotFound: this process holds no queued, running or recent execution by that ID.
	StopNotFound = "not_found"
)

// StopResult says what a stop request found. Status is StopStopping, StopNotFound, or how the
// execution had already ended (RunStatusDone, RunStatusFailed, RunStatusCanceled).
type StopResult struct {
	Status string `json:"status"`
	ID     string `json:"id"`
	RunID  string `json:"run_id"`
	// Run is the execution while it is still held, Finished how it ended.
	Run      *TaskRun     `json:"run,omitempty"`
	Finished *FinishedRun `json:"finished,omitempty"`
}

// finishedRunsKept bounds the recent outcomes a board remembers for clients that stopped a run.
const finishedRunsKept = 64

type boardRun struct {
	TaskRun
	cancel context.CancelCauseFunc
}

// RunBoard holds the tasks one cron loop has queued or running, keyed by task ID (a loop holds
// at most one execution per task), and how its recent executions ended. A loop registers its
// board under its cron file, so other parts of the same process (the TODO API) can list them.
type RunBoard struct {
	mu       sync.Mutex
	seq      uint64
	runs     map[string]*boardRun
	finished []FinishedRun
}

// NewRunID returns a fresh execution ID, unique across processes.
func NewRunID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "run_" + strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	return "run_" + hex.EncodeToString(b[:])
}

// Queue records a task waiting for a slot and returns the new execution's ID. The methods do
// nothing on a nil board (Queue then returns "").
func (b *RunBoard) Queue(id string, manual bool, at time.Time) string {
	if b == nil {
		return ""
	}
	runID := NewRunID()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.runs == nil {
		b.runs = map[string]*boardRun{}
	}
	b.seq++
	b.runs[id] = &boardRun{TaskRun: TaskRun{ID: id, RunID: runID, State: RunQueued, Manual: manual, QueuedAt: at.UTC(), seq: b.seq}}
	return runID
}

// Start marks a queued execution as running; cancel stops it. It returns false, and records
// nothing, when the execution was stopped while it waited: the caller must not run it and
// should Finish it as RunStatusCanceled. runID "" takes whatever execution the task has.
func (b *RunBoard) Start(id, runID string, at time.Time, cancel context.CancelCauseFunc) bool {
	if b == nil {
		return true
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	run, ok := b.runs[id]
	if ok && runID != "" && run.RunID != runID {
		ok = false
	}
	if !ok {
		run = &boardRun{TaskRun: TaskRun{ID: id, RunID: runID, QueuedAt: at.UTC()}}
		if b.runs == nil {
			b.runs = map[string]*boardRun{}
		}
		b.runs[id] = run
	}
	if run.Stopping {
		return false
	}
	run.State = RunRunning
	run.StartedAt = at.UTC()
	run.cancel = cancel
	return true
}

// Stop asks the execution runID of task id to stop: a running one has its context cancelled
// with ErrRunStopped, a queued one will not start. Asking again while it winds down only
// reports StopStopping. An execution that already ended reports how; another execution of the
// same task (an earlier or later run) is never touched.
func (b *RunBoard) Stop(id, runID string) StopResult {
	result := StopResult{Status: StopNotFound, ID: id, RunID: runID}
	if b == nil || strings.TrimSpace(id) == "" || strings.TrimSpace(runID) == "" {
		return result
	}
	var cancel context.CancelCauseFunc
	b.mu.Lock()
	if run, ok := b.runs[id]; ok && run.RunID == runID {
		if !run.Stopping {
			run.Stopping = true
			cancel = run.cancel
		}
		snapshot := run.TaskRun
		result.Status = StopStopping
		result.Run = &snapshot
	} else if finished, ok := b.findFinishedLocked(id, runID); ok {
		result.Status = finished.Status
		result.Finished = &finished
	}
	b.mu.Unlock()
	if cancel != nil {
		cancel(ErrRunStopped)
	}
	return result
}

// Finish removes an execution that ended and remembers how (status is RunStatusDone,
// RunStatusFailed or RunStatusCanceled). A runID that is no longer the task's execution only
// adds the record.
func (b *RunBoard) Finish(id, runID, status string, at time.Time) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	stopping := false
	if run, ok := b.runs[id]; ok && (runID == "" || run.RunID == runID) {
		stopping = run.Stopping
		if runID == "" {
			runID = run.RunID
		}
		delete(b.runs, id)
	}
	if runID == "" {
		return
	}
	b.finished = append(b.finished, FinishedRun{ID: id, RunID: runID, Status: status, Stopping: stopping, FinishedAt: at.UTC()})
	if extra := len(b.finished) - finishedRunsKept; extra > 0 {
		b.finished = append([]FinishedRun(nil), b.finished[extra:]...)
	}
}

// Done removes a task that was dropped without running (a full queue, a shutdown); it keeps
// no record of it.
func (b *RunBoard) Done(id string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	delete(b.runs, id)
	b.mu.Unlock()
}

func (b *RunBoard) findFinishedLocked(id, runID string) (FinishedRun, bool) {
	for i := len(b.finished) - 1; i >= 0; i-- {
		if f := b.finished[i]; f.RunID == runID && f.ID == id {
			return f, true
		}
	}
	return FinishedRun{}, false
}

func (b *RunBoard) list() []TaskRun {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]TaskRun, 0, len(b.runs))
	for _, run := range b.runs {
		out = append(out, run.TaskRun)
	}
	return out
}

func (b *RunBoard) listFinished() []FinishedRun {
	b.mu.Lock()
	defer b.mu.Unlock()
	return append([]FinishedRun(nil), b.finished...)
}

var runBoards = struct {
	sync.Mutex
	byPath map[string]map[*RunBoard]struct{}
}{byPath: map[string]map[*RunBoard]struct{}{}}

func runBoardKey(path string) string {
	path = pathutil.ExpandHomePath(strings.TrimSpace(path))
	if path == "" {
		return ""
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	return filepath.Clean(path)
}

// RegisterRunBoard publishes a loop's board under its cron file until the returned func is called.
func RegisterRunBoard(path string, board *RunBoard) func() {
	key := runBoardKey(path)
	if key == "" || board == nil {
		return func() {}
	}
	runBoards.Lock()
	if runBoards.byPath[key] == nil {
		runBoards.byPath[key] = map[*RunBoard]struct{}{}
	}
	runBoards.byPath[key][board] = struct{}{}
	runBoards.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			runBoards.Lock()
			delete(runBoards.byPath[key], board)
			if len(runBoards.byPath[key]) == 0 {
				delete(runBoards.byPath, key)
			}
			runBoards.Unlock()
		})
	}
}

func boardsFor(path string) []*RunBoard {
	key := runBoardKey(path)
	runBoards.Lock()
	defer runBoards.Unlock()
	boards := make([]*RunBoard, 0, len(runBoards.byPath[key]))
	for board := range runBoards.byPath[key] {
		boards = append(boards, board)
	}
	return boards
}

// Runs lists the tasks queued or running in this process for the cron file at path: running tasks
// first, by start time, then queued ones in the order they will start.
func Runs(path string) []TaskRun {
	out := []TaskRun{}
	for _, board := range boardsFor(path) {
		out = append(out, board.list()...)
	}
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.State != b.State {
			return a.State == RunRunning
		}
		if a.State == RunRunning && !a.StartedAt.Equal(b.StartedAt) {
			return a.StartedAt.Before(b.StartedAt)
		}
		if !a.QueuedAt.Equal(b.QueuedAt) {
			return a.QueuedAt.Before(b.QueuedAt)
		}
		if a.seq != b.seq {
			return a.seq < b.seq
		}
		return a.ID < b.ID
	})
	return out
}

// FinishedRuns lists how the recent executions of this process's loops for the cron file at
// path ended, oldest first.
func FinishedRuns(path string) []FinishedRun {
	out := []FinishedRun{}
	for _, board := range boardsFor(path) {
		out = append(out, board.listFinished()...)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].FinishedAt.Before(out[j].FinishedAt) })
	return out
}

// StopRun asks the execution runID of task id, held by a loop of this process for the cron file
// at path, to stop (see RunBoard.Stop).
func StopRun(path, id, runID string) StopResult {
	id = strings.TrimSpace(id)
	runID = strings.TrimSpace(runID)
	result := StopResult{Status: StopNotFound, ID: id, RunID: runID}
	for _, board := range boardsFor(path) {
		if got := board.Stop(id, runID); got.Status != StopNotFound {
			return got
		}
	}
	return result
}
