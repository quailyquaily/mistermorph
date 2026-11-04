package agent

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// WorkerMetadata identifies a worker within a task. Processes are historical records,
// not a claim that the processes are still running.
type WorkerMetadata struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Processes []WorkerProcess `json:"processes,omitempty"`
}

type WorkerProcess struct {
	PID        int    `json:"pid"`
	Program    string `json:"program"`
	ActivityID string `json:"activity_id,omitempty"`
}

type workerScopeKey struct{}
type workerContextKey struct{}
type workerScope struct {
	mu    sync.Mutex
	next  int
	calls map[string]*workerState
}
type workerState struct {
	mu       sync.Mutex
	metadata WorkerMetadata
}

var workerNames = [...]string{"Milo", "Luna", "Pip", "Cleo", "Finn", "Nova", "Remy", "Iris"}

// withWorkerScope shares one allocator across a task and all its nested runs.
func withWorkerScope(ctx context.Context) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Value(workerScopeKey{}).(*workerScope); ok {
		return ctx
	}
	return context.WithValue(ctx, workerScopeKey{}, &workerScope{calls: make(map[string]*workerState)})
}

// withResumedWorkerScope is withWorkerScope for a run resumed after an approval pause; the
// first new worker gets the name after the allocated ones.
func withResumedWorkerScope(ctx context.Context, allocated int) context.Context {
	ctx = withWorkerScope(ctx)
	scope := ctx.Value(workerScopeKey{}).(*workerScope)
	scope.mu.Lock()
	if allocated > scope.next {
		scope.next = allocated
	}
	scope.mu.Unlock()
	return ctx
}

// workersAllocated reports how many workers the context's scope has named.
func workersAllocated(ctx context.Context) int {
	if ctx == nil {
		return 0
	}
	scope, ok := ctx.Value(workerScopeKey{}).(*workerScope)
	if !ok {
		return 0
	}
	scope.mu.Lock()
	defer scope.mu.Unlock()
	return scope.next
}

func workerCallKey(ctx context.Context, activityID string) string {
	return llmstats.RunIDFromContext(ctx) + ":" + activityID
}

func allocateWorker(ctx context.Context, key string) *workerState {
	scope := ctx.Value(workerScopeKey{}).(*workerScope)
	scope.mu.Lock()
	defer scope.mu.Unlock()
	if worker := scope.calls[key]; worker != nil {
		return worker
	}
	n := scope.next
	scope.next++
	name := workerNames[n%len(workerNames)]
	if round := n / len(workerNames); round > 0 {
		name = fmt.Sprintf("%s-%d", name, round+1)
	}
	worker := &workerState{metadata: WorkerMetadata{ID: fmt.Sprintf("worker-%d", n+1), Name: name}}
	scope.calls[key] = worker
	return worker
}

func workerForEvent(ctx context.Context, event Event) *workerState {
	if event.Kind == EventKindToolStart || event.Kind == EventKindToolDone {
		if scope, ok := ctx.Value(workerScopeKey{}).(*workerScope); ok {
			scope.mu.Lock()
			worker := scope.calls[workerCallKey(ctx, event.ActivityID)]
			scope.mu.Unlock()
			if worker != nil {
				return worker
			}
		}
	}
	worker, _ := ctx.Value(workerContextKey{}).(*workerState)
	return worker
}

// WorkerFromContext returns an independent snapshot safe to retain in events and results.
func WorkerFromContext(ctx context.Context) *WorkerMetadata {
	if ctx == nil {
		return nil
	}
	worker, _ := ctx.Value(workerContextKey{}).(*workerState)
	return worker.snapshot()
}

func (w *workerState) snapshot() *WorkerMetadata {
	if w == nil {
		return nil
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	out := w.metadata
	out.Processes = append([]WorkerProcess(nil), out.Processes...)
	return &out
}

// RecordWorkerProcess is called only after a successful OS process start, or when
// attaching a task to an already started terminal. It never extracts PIDs from text.
func RecordWorkerProcess(ctx context.Context, program string, pid int) {
	if ctx == nil || pid <= 0 {
		return
	}
	worker, _ := ctx.Value(workerContextKey{}).(*workerState)
	if worker == nil {
		return
	}
	call, _ := ctx.Value(toolActivityContextKey{}).(toolActivity)
	process := WorkerProcess{PID: pid, Program: filepath.Base(program), ActivityID: call.id}
	worker.mu.Lock()
	for _, existing := range worker.metadata.Processes {
		if existing == process {
			worker.mu.Unlock()
			return
		}
	}
	worker.metadata.Processes = append(worker.metadata.Processes, process)
	worker.mu.Unlock()
	EmitEvent(ctx, nil, Event{Kind: EventKindWorkerProcess, ActivityID: call.id, ParentActivityID: call.parentID})
}
