package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
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
