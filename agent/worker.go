package agent

import (
	"context"
	"fmt"
	"math/rand/v2"
	"path/filepath"
	"strings"
	"sync"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// WorkerMetadata identifies a worker within a task. ID is the worker's identity; Name is its
// English display name, for logs, the model and older readers. NameSet, NameIndex and
// AvatarIndex are the picks a client turns into a name in its own language and a logo style;
// records written before they existed lack them. Processes are historical records, not a claim
// that the processes are still running.
type WorkerMetadata struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// NameSet is the pool NameIndex picks from (see WorkerNameSets). Records written before
	// name sets have none: their index picks a scientist, or a legacy first name.
	NameSet string `json:"name_set,omitempty"`
	// NameIndex picks from the set's name pools: entry NameIndex % pool size, with the suffix
	// "-<n+1>" for the n = NameIndex / pool size round, once a task has used every name.
	NameIndex *int `json:"name_index,omitempty"`
	// AvatarIndex picks one of the logo styles.
	AvatarIndex *int            `json:"avatar_index,omitempty"`
	Processes   []WorkerProcess `json:"processes,omitempty"`
}

type WorkerProcess struct {
	PID        int    `json:"pid"`
	Program    string `json:"program"`
	ActivityID string `json:"activity_id,omitempty"`
}

type workerScopeKey struct{}
type workerContextKey struct{}
type workerScope struct {
	mu   sync.Mutex
	next int
	// seed decides the task's name and avatar orders; 0 keeps the legacy sequential order.
	seed uint64
	// nameSet is the pool the task's workers are named from, fixed when the task starts.
	nameSet string
	names   []int
	avatars []int
	calls   map[string]*workerState
}
type workerState struct {
	mu       sync.Mutex
	metadata WorkerMetadata
}

// workerAvatarCount is the number of logo styles (the brand colourways) the Console draws
// worker avatars from: web/console-nsh/assets/worker-avatars.
const workerAvatarCount = 7

// newWorkerSeed draws a task's seed; tests replace it to control the allocation.
var newWorkerSeed = func() uint64 {
	for {
		if seed := rand.Uint64(); seed != 0 {
			return seed
		}
	}
}

func newWorkerScope(seed uint64, nameSet string) *workerScope {
	nameSet = NormalizeWorkerNameSet(nameSet)
	return &workerScope{
		seed:    seed,
		nameSet: nameSet,
		names:   workerPermutation(seed, 1, len(workerNamePool(nameSet))),
		avatars: workerPermutation(seed, 2, workerAvatarCount),
		calls:   make(map[string]*workerState),
	}
}

// workerPermutation shuffles 0..n-1 from seed; stream keeps the name and avatar orders
// independent. Seed 0 returns the identity order. The shuffle is SplitMix64 driving
// Fisher-Yates, so a persisted seed gives the same order in every build.
func workerPermutation(seed, stream uint64, n int) []int {
	order := make([]int, n)
	for i := range order {
		order[i] = i
	}
	if seed == 0 {
		return order
	}
	state := seed ^ stream*0x9e3779b97f4a7c15
	for i := n - 1; i > 0; i-- {
		state += 0x9e3779b97f4a7c15
		z := state
		z = (z ^ z>>30) * 0xbf58476d1ce4e5b9
		z = (z ^ z>>27) * 0x94d049bb133111eb
		z ^= z >> 31
		j := int(z % uint64(i+1))
		order[i], order[j] = order[j], order[i]
	}
	return order
}

// workerName is the English display name for a name index in a set.
func workerName(nameSet string, nameIndex int) string {
	pool := workerNamePool(nameSet)
	name := pool[nameIndex%len(pool)]
	if round := nameIndex / len(pool); round > 0 {
		name = fmt.Sprintf("%s-%d", name, round+1)
	}
	return name
}

// withWorkerScope shares one allocator across a task and all its nested runs. A new scope names
// its workers from nameSet; a nested run keeps the scope, and so the set, of its task.
func withWorkerScope(ctx context.Context, nameSet string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if _, ok := ctx.Value(workerScopeKey{}).(*workerScope); ok {
		return ctx
	}
	return context.WithValue(ctx, workerScopeKey{}, newWorkerScope(newWorkerSeed(), nameSet))
}

// withResumedWorkerScope is withWorkerScope for a run resumed after an approval pause: it
// keeps the seed and name set the task had, so the first new worker gets the next name and
// avatar in the same order, from the same pool, whatever the set preference is now. A pause
// recorded before seeds existed (seed 0 with workers allocated) continues the legacy sequential
// order, and one recorded before name sets continues with the scientists. A pause with neither
// a seed nor a worker named starts afresh, from its recorded set or else currentSet.
func withResumedWorkerScope(ctx context.Context, allocated int, seed uint64, nameSet, currentSet string) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	recorded := strings.TrimSpace(nameSet) != ""
	if seed == 0 && allocated <= 0 {
		if !recorded {
			nameSet = currentSet
		}
		return withWorkerScope(ctx, nameSet)
	}
	if !recorded {
		nameSet = DefaultWorkerNameSet
	}
	nameSet = NormalizeWorkerNameSet(nameSet)
	scope, ok := ctx.Value(workerScopeKey{}).(*workerScope)
	if !ok {
		scope = newWorkerScope(seed, nameSet)
		ctx = context.WithValue(ctx, workerScopeKey{}, scope)
	}
	scope.mu.Lock()
	if scope.next == 0 && (scope.seed != seed || scope.nameSet != nameSet) {
		fresh := newWorkerScope(seed, nameSet)
		scope.seed, scope.nameSet, scope.names, scope.avatars = fresh.seed, fresh.nameSet, fresh.names, fresh.avatars
	}
	if allocated > scope.next {
		scope.next = allocated
	}
	scope.mu.Unlock()
	return ctx
}

// workersAllocated reports how many workers the context's scope has named, and the seed and
// name set their names and avatars came from.
func workersAllocated(ctx context.Context) (int, uint64, string) {
	if ctx == nil {
		return 0, 0, ""
	}
	scope, ok := ctx.Value(workerScopeKey{}).(*workerScope)
	if !ok {
		return 0, 0, ""
	}
	scope.mu.Lock()
	defer scope.mu.Unlock()
	return scope.next, scope.seed, scope.nameSet
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
	// Every name is used once before any repeats, and a repeat takes the round as a suffix;
	// avatars cycle through the styles in the task's order.
	pool := len(scope.names)
	nameIndex := n/pool*pool + scope.names[n%pool]
	avatarIndex := scope.avatars[n%len(scope.avatars)]
	worker := &workerState{metadata: WorkerMetadata{
		ID:          fmt.Sprintf("worker-%d", n+1),
		Name:        workerName(scope.nameSet, nameIndex),
		NameSet:     scope.nameSet,
		NameIndex:   &nameIndex,
		AvatarIndex: &avatarIndex,
	}}
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
