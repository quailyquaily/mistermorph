package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestWorkerNamesStableDistinctAndNested(t *testing.T) {
	ctx := withWorkerScope(context.Background())
	engine := New(nil, tools.NewRegistry(), Config{}, DefaultPromptSpec())
	var mu sync.Mutex
	var events []Event
	ctx = WithEventSinkContext(ctx, EventSinkFunc(func(_ context.Context, event Event) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
	}))
	var wg sync.WaitGroup
	for i := 0; i < len(workerNames)*3; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			call := &ToolCall{ID: fmt.Sprintf("call-%d", i), Name: "coder", ParentID: "codemode"}
			if _, err := engine.executeFoundTool(ctx, &engineLoopState{}, 1, call, &executeToolStub{name: "coder"}); err != nil {
				t.Error(err)
			}
			EmitEvent(ctx, nil, Event{Kind: EventKindToolDone, ActivityID: call.ID, ToolName: call.Name})
		}(i)
	}
	wg.Wait()
	names := map[string]string{}
	workers := map[string]*WorkerMetadata{}
	for _, event := range events {
		if event.Worker == nil || event.Worker.Name == "" {
			t.Fatalf("missing worker: %+v", event)
		}
		if prior := workers[event.ActivityID]; prior != nil && !reflect.DeepEqual(prior, event.Worker) {
			t.Fatalf("worker changed: %+v", event)
		}
		if owner := names[event.Worker.Name]; owner != "" && owner != event.ActivityID {
			t.Fatalf("duplicate name %q", event.Worker.Name)
		}
		workers[event.ActivityID] = event.Worker
		names[event.Worker.Name] = event.ActivityID
	}
	if len(names) != len(workerNames)*3 {
		t.Fatalf("names=%v", names)
	}
	// Nested runs may receive identical call IDs from a different model invocation.
	_, child, _ := PrepareSubtaskContext(ctx, nil)
	nested := allocateWorker(child, workerCallKey(child, "call-0"))
	if names[nested.snapshot().Name] != "" {
		t.Fatal("nested worker reused a name")
	}
	again := allocateWorker(child, workerCallKey(child, "call-0"))
	if nested != again {
		t.Fatal("worker identity changed")
	}
}

func TestWorkerSubtaskLifecycleAndSerialization(t *testing.T) {
	var events []Event
	ctx := WithEventSinkContext(withWorkerScope(context.Background()), EventSinkFunc(func(_ context.Context, event Event) { events = append(events, event) }))
	ctx = llmstats.WithRunID(ctx, "parent")
	ctx = withToolActivity(ctx, "spawn-call", "")
	worker := allocateWorker(ctx, workerCallKey(ctx, "spawn-call"))
	ctx = context.WithValue(ctx, workerContextKey{}, worker)
	runner := &localSubtaskRunner{engine: New(nil, tools.NewRegistry(), Config{}, DefaultPromptSpec())}
	result, err := runner.RunSubtask(ctx, SubtaskRequest{RunFunc: func(runCtx context.Context) (*SubtaskResult, error) {
		if got := WorkerFromContext(runCtx); got.ID != worker.snapshot().ID {
			t.Fatalf("subtask allocated a second worker: %+v", got)
		}
		RecordWorkerProcess(runCtx, "bash", 123)
		RecordWorkerProcess(runCtx, "bash", 123)
		RecordWorkerProcess(runCtx, "bash", 0)
		RecordWorkerProcess(runCtx, "codex", 456)
		return &SubtaskResult{Output: "done"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Worker == nil || len(result.Worker.Processes) != 2 {
		t.Fatalf("result=%+v", result)
	}
	if len(events) != 4 {
		t.Fatalf("events=%+v", events)
	}
	if len(events[0].Worker.Processes) != 0 {
		t.Fatal("start snapshot mutated")
	}
	if !reflect.DeepEqual(events[len(events)-1].Worker, result.Worker) {
		t.Fatal("done metadata differs from result")
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var loaded SubtaskResult
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded.Worker, result.Worker) {
		t.Fatal("result lost worker metadata")
	}
	var legacy SubtaskResult
	if err := json.Unmarshal([]byte(`{"task_id":"old","status":"done"}`), &legacy); err != nil {
		t.Fatal(err)
	}
}

func TestInProcessSubtaskHasNameWithoutPID(t *testing.T) {
	runner := &localSubtaskRunner{engine: New(nil, tools.NewRegistry(), Config{}, DefaultPromptSpec())}
	result, err := runner.RunSubtask(context.Background(), SubtaskRequest{RunFunc: func(context.Context) (*SubtaskResult, error) {
		return &SubtaskResult{Output: "in-process work"}, nil
	}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Worker == nil || result.Worker.Name == "" || len(result.Worker.Processes) != 0 {
		t.Fatalf("worker=%+v", result.Worker)
	}
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	var loaded SubtaskResult
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(result.Worker, loaded.Worker) {
		t.Fatal("reload changed an in-process worker")
	}
}

type workerRecordingTool struct {
	mu    sync.Mutex
	names []string
}

func (t *workerRecordingTool) Name() string            { return "coder" }
func (t *workerRecordingTool) Description() string     { return "records its worker" }
func (t *workerRecordingTool) ParameterSchema() string { return "{}" }
func (t *workerRecordingTool) Execute(ctx context.Context, _ map[string]any) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if worker := WorkerFromContext(ctx); worker != nil {
		t.names = append(t.names, worker.ID+"/"+worker.Name)
	} else {
		t.names = append(t.names, "")
	}
	return "ok", nil
}

// Coders started after an approval pause share one scope and continue the names given out
// before the pause.
func TestWorkerNamesContinueAfterApprovalResume(t *testing.T) {
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
		llm.Result{ToolCalls: []llm.ToolCall{
			{ID: "c2", Name: "coder", Arguments: map[string]any{"task": "a"}},
			{ID: "c3", Name: "coder", Arguments: map[string]any{"task": "b"}},
		}},
		finalResponse("done"),
	)
	engine := New(client, registry, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g))
	pending, _, err := engine.Run(context.Background(), "work", RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	approvalID := pendingApprovalID(t, pending)
	rec, _, err := store.Get(context.Background(), approvalID)
	if err != nil {
		t.Fatal(err)
	}
	if rs, err := unmarshalResumeState(rec.ResumeState); err != nil || rs.WorkerSeed != 0x5eed || rs.WorkersAllocated != 1 {
		t.Fatalf("resume state = %+v, %v", rs, err)
	}
	// The resumed run must not draw a new seed.
	newWorkerSeed = func() uint64 { t.Fatal("resume drew a new worker seed"); return 1 }
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatal(err)
	}
	if final, _, err := engine.Resume(context.Background(), approvalID); err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Resume() = %#v, %v", final, err)
	}
	seen := map[string]bool{}
	for _, name := range coder.names {
		if name == "" || seen[name] {
			t.Fatalf("coder workers = %v, want three distinct", coder.names)
		}
		seen[name] = true
	}
	for i := 0; i < 3; i++ {
		if want := fmt.Sprintf("worker-%d/%s", i+1, workerNames[order[i]]); !seen[want] {
			t.Fatalf("coder workers = %v, want %s", coder.names, want)
		}
	}
}
