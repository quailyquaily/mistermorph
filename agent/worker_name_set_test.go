package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestWorkerNameSetPools(t *testing.T) {
	if got := WorkerNameSets(); !slices.Equal(got, []string{"scientists", "musicians", "artists"}) {
		t.Fatalf("sets = %v", got)
	}
	seen := map[string]string{}
	for _, set := range WorkerNameSets() {
		pool := workerNamePool(set)
		// A recorded index picks the same entry in every build and every set.
		if len(pool) != len(workerNames) {
			t.Fatalf("%s has %d names, want %d", set, len(pool), len(workerNames))
		}
		for _, name := range pool {
			// A repeat adds "-<n>", so a name must not contain a dash of its own.
			if name == "" || name != strings.TrimSpace(name) || strings.Contains(name, "-") {
				t.Fatalf("%s name %q", set, name)
			}
			// A recorded name tells which pool it came from.
			if other, ok := seen[name]; ok {
				t.Fatalf("%q is in %s and %s", name, other, set)
			}
			seen[name] = set
		}
	}
	for index, want := range map[int]string{0: "Bach", 31: "Sakamoto", 33: "Mozart-2"} {
		if got := workerName(WorkerNameSetMusicians, index); got != want {
			t.Fatalf("musician %d = %q, want %q", index, got, want)
		}
	}
	for index, want := range map[int]string{0: "Leonardo", 5: "Van Gogh", 37: "Van Gogh-2"} {
		if got := workerName(WorkerNameSetArtists, index); got != want {
			t.Fatalf("artist %d = %q, want %q", index, got, want)
		}
	}
	// The scientists stay where recorded indices expect them.
	if workerName(WorkerNameSetScientists, 4) != "Noether" || workerName("", 31) != "Archimedes" {
		t.Fatal("scientist pool moved")
	}
}

func TestNormalizeWorkerNameSet(t *testing.T) {
	for _, tc := range []struct{ in, want string }{
		{"", "scientists"},
		{"scientists", "scientists"},
		{"musicians", "musicians"},
		{" Artists ", "artists"},
		{"MUSICIANS", "musicians"},
		{"poets", "scientists"},
		{"musician", "scientists"},
	} {
		if got := NormalizeWorkerNameSet(tc.in); got != tc.want {
			t.Errorf("NormalizeWorkerNameSet(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestWorkerAllocationUsesTheTaskNameSet(t *testing.T) {
	const seed = 0xfeed
	for _, set := range WorkerNameSets() {
		t.Run(set, func(t *testing.T) {
			useWorkerSeeds(t, seed)
			ctx := withWorkerScope(context.Background(), set)
			order := workerPermutation(seed, 1, len(workerNames))
			for n := 0; n < 3; n++ {
				got := allocateWorker(ctx, fmt.Sprintf("call-%d", n)).snapshot()
				if got.NameSet != set || *got.NameIndex != order[n] || got.Name != workerNamePool(set)[order[n]] {
					t.Fatalf("worker %d = %+v", n, got)
				}
			}
			if _, _, gotSet := workersAllocated(ctx); gotSet != set {
				t.Fatalf("scope set = %q", gotSet)
			}
		})
	}
	t.Run("unknown set", func(t *testing.T) {
		ctx := withWorkerScope(context.Background(), "poets")
		if got := allocateWorker(ctx, "call").snapshot(); got.NameSet != WorkerNameSetScientists || !slices.Contains(workerNames[:], got.Name) {
			t.Fatalf("worker = %+v", got)
		}
	})
	t.Run("a nested run keeps its task's set", func(t *testing.T) {
		// The preference changed while the task ran: a nested run's engine has the new set,
		// but the task's workers keep the one it started with.
		ctx := withWorkerScope(context.Background(), WorkerNameSetMusicians)
		ctx = withWorkerScope(ctx, WorkerNameSetArtists)
		if got := allocateWorker(ctx, "call").snapshot(); got.NameSet != WorkerNameSetMusicians {
			t.Fatalf("worker = %+v", got)
		}
	})
}

func TestWorkerResumeKeepsTheTaskNameSet(t *testing.T) {
	const seed = 0xabc
	useWorkerSeeds(t, seed)
	ctx := withWorkerScope(context.Background(), WorkerNameSetMusicians)
	var uninterrupted []WorkerMetadata
	for n := 0; n < 5; n++ {
		uninterrupted = append(uninterrupted, *allocateWorker(ctx, fmt.Sprintf("call-%d", n)).snapshot())
	}

	newWorkerSeed = func() uint64 { t.Fatal("resume drew a new seed"); return 1 }
	// The preference is now artists; the paused task still names musicians.
	resumed := withResumedWorkerScope(context.Background(), 2, seed, WorkerNameSetMusicians, WorkerNameSetArtists)
	for n := 2; n < 5; n++ {
		got := allocateWorker(resumed, fmt.Sprintf("after-%d", n)).snapshot()
		if !reflect.DeepEqual(*got, uninterrupted[n]) {
			t.Fatalf("worker %d after resume = %+v, want %+v", n, got, uninterrupted[n])
		}
	}

	t.Run("an existing scope adopts the set before its first worker", func(t *testing.T) {
		useWorkerSeeds(t, 5)
		ctx := withResumedWorkerScope(withWorkerScope(context.Background(), WorkerNameSetScientists), 1, seed, WorkerNameSetArtists, WorkerNameSetScientists)
		if _, gotSeed, set := workersAllocated(ctx); gotSeed != seed || set != WorkerNameSetArtists {
			t.Fatalf("seed %d set %q", gotSeed, set)
		}
	})
	t.Run("a pause with no worker yet and no set takes the preference", func(t *testing.T) {
		useWorkerSeeds(t, 9)
		ctx := withResumedWorkerScope(context.Background(), 0, 0, "", WorkerNameSetArtists)
		if _, _, set := workersAllocated(ctx); set != WorkerNameSetArtists {
			t.Fatalf("set %q", set)
		}
	})
}

func TestWorkerNameSetJSON(t *testing.T) {
	three := 3
	worker := WorkerMetadata{ID: "worker-1", Name: "Chopin", NameSet: WorkerNameSetMusicians, NameIndex: &three, AvatarIndex: &three}
	raw, err := json.Marshal(worker)
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != `{"id":"worker-1","name":"Chopin","name_set":"musicians","name_index":3,"avatar_index":3}` {
		t.Fatalf("json = %s", raw)
	}
	var loaded WorkerMetadata
	if err := json.Unmarshal(raw, &loaded); err != nil || !reflect.DeepEqual(loaded, worker) {
		t.Fatalf("round trip = %+v, %v", loaded, err)
	}
	// Records from before name sets have none, and stay that way.
	var legacy WorkerMetadata
	if err := json.Unmarshal([]byte(`{"id":"worker-2","name":"Curie","name_index":1}`), &legacy); err != nil || legacy.NameSet != "" {
		t.Fatalf("legacy = %+v, %v", legacy, err)
	}
	if raw, _ := json.Marshal(legacy); strings.Contains(string(raw), "name_set") {
		t.Fatalf("legacy json = %s", raw)
	}

	rs := resumeState{WorkersAllocated: 2, WorkerSeed: 7, WorkerNameSet: WorkerNameSetArtists}
	raw, _ = json.Marshal(rs)
	var loadedState resumeState
	if err := json.Unmarshal(raw, &loadedState); err != nil || loadedState.WorkerNameSet != WorkerNameSetArtists {
		t.Fatalf("resume state round trip = %+v, %v", loadedState, err)
	}
	var oldState resumeState
	if err := json.Unmarshal([]byte(`{"workers_allocated":2,"worker_seed":7}`), &oldState); err != nil || oldState.WorkerNameSet != "" {
		t.Fatalf("old resume state = %+v, %v", oldState, err)
	}
}

// namedTool records the worker of each call, under any tool name.
type namedTool struct {
	name    string
	mu      sync.Mutex
	workers []WorkerMetadata
}

func (t *namedTool) Name() string            { return t.name }
func (t *namedTool) Description() string     { return "records its worker" }
func (t *namedTool) ParameterSchema() string { return "{}" }
func (t *namedTool) Execute(ctx context.Context, _ map[string]any) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if worker := WorkerFromContext(ctx); worker != nil {
		t.workers = append(t.workers, *worker)
	}
	return "ok", nil
}

// Both naming consumers, a real spawn subtask and a coder call, name their workers from the
// engine's configured set.
func TestSpawnAndCoderWorkersUseTheConfiguredNameSet(t *testing.T) {
	for _, set := range WorkerNameSets() {
		t.Run(set, func(t *testing.T) {
			coder := &namedTool{name: "coder"}
			fetch := &namedTool{name: "url_fetch"}
			registry := tools.NewRegistry()
			registry.Register(coder)
			registry.Register(fetch)
			client := newMockClient(
				llm.Result{ToolCalls: []llm.ToolCall{{ID: "s1", Name: "spawn", Arguments: map[string]any{"task": "look", "tools": []any{"url_fetch"}}}}},
				// The subagent's own run.
				llm.Result{ToolCalls: []llm.ToolCall{{ID: "f1", Name: "url_fetch", Arguments: map[string]any{}}}},
				finalResponse("looked"),
				llm.Result{ToolCalls: []llm.ToolCall{{ID: "c1", Name: "coder", Arguments: map[string]any{}}}},
				finalResponse("done"),
			)
			engine := New(client, registry, Config{MaxSteps: 6}, DefaultPromptSpec(),
				WithEngineToolsConfig(EngineToolsConfig{SpawnEnabled: true, WorkerNameSet: set}))
			var mu sync.Mutex
			workers := map[string]WorkerMetadata{}
			ctx := WithEventSinkContext(context.Background(), EventSinkFunc(func(_ context.Context, event Event) {
				mu.Lock()
				defer mu.Unlock()
				if event.Worker != nil && (event.ToolName == "spawn" || event.ToolName == "coder") {
					workers[event.ToolName] = *event.Worker
				}
			}))
			final, _, err := engine.Run(ctx, "work", RunOptions{})
			if err != nil || final == nil || final.Output != "done" {
				t.Fatalf("Run() = %#v, %v", final, err)
			}
			pool := workerNamePool(set)
			for _, tool := range []string{"spawn", "coder"} {
				worker, ok := workers[tool]
				if !ok || worker.NameSet != set || worker.NameIndex == nil || worker.Name != pool[*worker.NameIndex%len(pool)] {
					t.Fatalf("%s worker = %+v (%v)", tool, worker, ok)
				}
			}
			// The subagent runs as the spawn call's worker; the coder call is its own.
			if len(fetch.workers) != 1 || fetch.workers[0].ID != workers["spawn"].ID || fetch.workers[0].NameSet != set {
				t.Fatalf("subagent workers = %+v, spawn = %+v", fetch.workers, workers["spawn"])
			}
			if len(coder.workers) != 1 || coder.workers[0].ID == workers["spawn"].ID || coder.workers[0].Name != workers["coder"].Name {
				t.Fatalf("coder workers = %+v", coder.workers)
			}
		})
	}
}

// A task paused for approval keeps its name set when the preference changes before it resumes:
// the resumed run's engine is configured with the new set.
func TestApprovalResumeKeepsTheNameSetAcrossAPreferenceChange(t *testing.T) {
	useWorkerSeeds(t, 0x5eed)
	order := workerPermutation(0x5eed, 1, len(workerNames))
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	coder := &workerRecordingTool{}
	var installs int
	registry := tools.NewRegistry()
	registry.Register(coder)
	registry.Register(&countingTool{name: "skill_install", result: "installed", count: &installs})
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "c1", Name: "coder", Arguments: map[string]any{}}}},
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "i1", Name: "skill_install", Arguments: map[string]any{"preview_id": "p1"}}}},
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "c2", Name: "coder", Arguments: map[string]any{"task": "a"}}}},
		finalResponse("done"),
	)
	before := New(client, registry, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g),
		WithEngineToolsConfig(EngineToolsConfig{SpawnEnabled: true, WorkerNameSet: WorkerNameSetMusicians}))
	pending, _, err := before.Run(context.Background(), "work", RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	approvalID := pendingApprovalID(t, pending)
	rec, _, err := store.Get(context.Background(), approvalID)
	if err != nil {
		t.Fatal(err)
	}
	if rs, err := unmarshalResumeState(rec.ResumeState); err != nil || rs.WorkerNameSet != WorkerNameSetMusicians || rs.WorkersAllocated != 1 {
		t.Fatalf("resume state = %+v, %v", rs, err)
	}
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatal(err)
	}
	after := New(client, registry, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g),
		WithEngineToolsConfig(EngineToolsConfig{SpawnEnabled: true, WorkerNameSet: WorkerNameSetArtists}))
	if final, _, err := after.Resume(context.Background(), approvalID); err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Resume() = %#v, %v", final, err)
	}
	want := []string{
		"worker-1/" + workerMusicianNames[order[0]],
		"worker-2/" + workerMusicianNames[order[1]],
	}
	if !slices.Equal(coder.names, want) {
		t.Fatalf("coder workers = %v, want %v", coder.names, want)
	}
}
