package cron

import (
	"path/filepath"
	"sort"
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

// TaskRun is one task a cron loop holds: waiting for a free slot, or running.
type TaskRun struct {
	ID        string    `json:"id"`
	State     RunState  `json:"state"`
	Manual    bool      `json:"manual,omitempty"`
	QueuedAt  time.Time `json:"queued_at"`
	StartedAt time.Time `json:"started_at,omitempty"`

	seq uint64 // Order of queueing, for queued tasks with the same time.
}

// RunBoard holds the tasks one cron loop has queued or running. A loop registers its board under
// its cron file, so other parts of the same process (the TODO API) can list them.
type RunBoard struct {
	mu   sync.Mutex
	seq  uint64
	runs map[string]TaskRun
}

// Queue records a task waiting for a slot. The methods do nothing on a nil board.
func (b *RunBoard) Queue(id string, manual bool, at time.Time) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.runs == nil {
		b.runs = map[string]TaskRun{}
	}
	b.seq++
	b.runs[id] = TaskRun{ID: id, State: RunQueued, Manual: manual, QueuedAt: at.UTC(), seq: b.seq}
}

// Start marks a queued task as running.
func (b *RunBoard) Start(id string, at time.Time) {
	if b == nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	run, ok := b.runs[id]
	if !ok {
		run = TaskRun{ID: id, QueuedAt: at.UTC()}
		if b.runs == nil {
			b.runs = map[string]TaskRun{}
		}
	}
	run.State = RunRunning
	run.StartedAt = at.UTC()
	b.runs[id] = run
}

// Done removes a task that finished, failed or was dropped.
func (b *RunBoard) Done(id string) {
	if b == nil {
		return
	}
	b.mu.Lock()
	delete(b.runs, id)
	b.mu.Unlock()
}

func (b *RunBoard) list() []TaskRun {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]TaskRun, 0, len(b.runs))
	for _, run := range b.runs {
		out = append(out, run)
	}
	return out
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

// Runs lists the tasks queued or running in this process for the cron file at path: running tasks
// first, by start time, then queued ones in the order they will start.
func Runs(path string) []TaskRun {
	key := runBoardKey(path)
	runBoards.Lock()
	boards := make([]*RunBoard, 0, len(runBoards.byPath[key]))
	for board := range runBoards.byPath[key] {
		boards = append(boards, board)
	}
	runBoards.Unlock()
	out := []TaskRun{}
	for _, board := range boards {
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
