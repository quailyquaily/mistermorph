package taskruntime

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

// nestedRuntimeSpawnClient plays every level of a nested spawn chain through the task runtime:
// below the depth limit each level spawns the next, the deepest level calls allowed_tool, and
// each level answers with the last tool result it saw.
type nestedRuntimeSpawnClient struct {
	// profileAt is the model_profile each depth passes to spawn.
	profileAt map[int]string
	// cancelAtLeaf cancels the run when the deepest level makes its first request.
	cancelAtLeaf context.CancelFunc

	mu      sync.Mutex
	calls   map[int]int
	offered map[int][]string
	models  map[int]string
}

func (c *nestedRuntimeSpawnClient) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	depth := agent.SubtaskDepthFromContext(ctx)
	c.mu.Lock()
	if c.calls == nil {
		c.calls, c.offered, c.models = map[int]int{}, map[int][]string{}, map[int]string{}
	}
	c.calls[depth]++
	call := c.calls[depth]
	if call == 1 {
		names := make([]string, 0, len(req.Tools))
		for _, tool := range req.Tools {
			names = append(names, tool.Name)
		}
		slices.Sort(names)
		c.offered[depth] = names
		c.models[depth] = req.Model
	}
	c.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return llm.Result{}, err
	}
	leaf := depth == agent.SubtaskMaxDepth
	if call == 1 {
		if leaf && c.cancelAtLeaf != nil {
			c.cancelAtLeaf()
			return llm.Result{}, context.Canceled
		}
		if leaf {
			return llm.Result{ToolCalls: []llm.ToolCall{{ID: "call_tool", Name: "allowed_tool", Arguments: map[string]any{}}}}, nil
		}
		args := map[string]any{"task": "nested work", "tools": []any{"allowed_tool", "spawn"}}
		if profile := c.profileAt[depth]; profile != "" {
			args["model_profile"] = profile
		}
		return llm.Result{ToolCalls: []llm.ToolCall{{ID: "call_spawn", Name: "spawn", Arguments: args}}}, nil
	}
	output := "leaf done"
	if !leaf {
		output = lastToolMessage(req)
	}
	raw, _ := json.Marshal(map[string]any{"type": "final", "output": output})
	return llm.Result{Text: string(raw)}, nil
}

func (c *nestedRuntimeSpawnClient) snapshot(depth int) ([]string, string, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	names, ok := c.offered[depth]
	return names, c.models[depth], ok
}

func TestPreparedEngineSpawnNestsToMaxDepth(t *testing.T) {
	values := subtaskProfileTestValues()
	// The depth 1 subtask picks the fast profile for its own subtask.
	client := &nestedRuntimeSpawnClient{profileAt: map[int]string{1: "fast"}}
	var created []llmutil.ResolvedRoute
	deps := subtaskProfileTestDeps(t, &values, func(llmutil.ResolvedRoute) llm.Client { return client }, &created)
	rt, err := NewRunPreparer(deps, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 4, ToolRepeatLimit: 2}})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	defer func() { _ = rt.Close() }()

	result, err := rt.Run(context.Background(), RunRequest{Task: "run parent task", DisableRuntimeTools: true})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	delegating := []string{"allowed_tool", "list_model_profiles", "spawn"}
	if got, _, _ := client.snapshot(0); !slices.Equal(got, delegating) {
		t.Fatalf("depth 0 tools = %v, want %v", got, delegating)
	}
	if got, model, _ := client.snapshot(1); !slices.Equal(got, delegating) || model != "gpt-main" {
		t.Fatalf("depth 1 tools/model = %v/%q, want %v on gpt-main", got, model, delegating)
	}
	got, model, ok := client.snapshot(2)
	if !ok || !slices.Equal(got, []string{"allowed_tool"}) {
		t.Fatalf("depth 2 tools = %v, want only allowed_tool (no further delegation)", got)
	}
	if model != "claude-fast" {
		t.Fatalf("depth 2 model = %q, want the fast profile selected at depth 1", model)
	}
	if _, _, ok := client.snapshot(3); ok {
		t.Fatal("a depth 3 subtask reached the model")
	}
	if len(created) != 3 || created[2].Profile != "fast" {
		t.Fatalf("created routes = %d (last %q), want root, depth 1 and fast depth 2", len(created), created[len(created)-1].Profile)
	}

	output, _ := result.Final.Output.(string)
	var depth1 agent.SubtaskResult
	if err := json.Unmarshal([]byte(output), &depth1); err != nil || depth1.Status != agent.SubtaskStatusDone {
		t.Fatalf("root output = %q (%v), want the done depth 1 envelope", output, err)
	}
	var depth2 agent.SubtaskResult
	if err := json.Unmarshal([]byte(depth1.Output.(string)), &depth2); err != nil {
		t.Fatalf("depth 1 output is not the depth 2 envelope: %v, raw=%v", err, depth1.Output)
	}
	if depth2.Status != agent.SubtaskStatusDone || depth2.Output != "leaf done" {
		t.Fatalf("depth 2 result = %+v, want done with leaf output", depth2)
	}
}

func TestPreparedEngineSpawnNestedCancellation(t *testing.T) {
	values := subtaskProfileTestValues()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &nestedRuntimeSpawnClient{cancelAtLeaf: cancel}
	var created []llmutil.ResolvedRoute
	deps := subtaskProfileTestDeps(t, &values, func(llmutil.ResolvedRoute) llm.Client { return client }, &created)
	rt, err := NewRunPreparer(deps, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 4, ToolRepeatLimit: 2}})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	defer func() { _ = rt.Close() }()

	_, err = rt.Run(ctx, RunRequest{Task: "run parent task", DisableRuntimeTools: true})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context.Canceled from the depth 2 subtask", err)
	}
	if _, _, ok := client.snapshot(2); !ok {
		t.Fatal("cancellation test never reached depth 2")
	}
}

func TestRunSubtaskAllowsDepthOneParent(t *testing.T) {
	values := subtaskProfileTestValues()
	client := &stubTaskRuntimeClient{}
	var created []llmutil.ResolvedRoute
	deps := subtaskProfileTestDeps(t, &values, func(llmutil.ResolvedRoute) llm.Client { return client }, &created)
	rt, err := NewRunPreparer(deps, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 2}})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	defer func() { _ = rt.Close() }()

	childDepth := -1
	result, err := rt.RunSubtask(agent.WithSubtaskDepth(context.Background(), 1), agent.SubtaskRequest{
		RunFunc: func(ctx context.Context) (*agent.SubtaskResult, error) {
			childDepth = agent.SubtaskDepthFromContext(ctx)
			return &agent.SubtaskResult{Status: agent.SubtaskStatusDone, Output: "ok"}, nil
		},
	})
	if err != nil || result == nil || result.Status != agent.SubtaskStatusDone {
		t.Fatalf("RunSubtask() = %+v, %v, want done", result, err)
	}
	if childDepth != agent.SubtaskMaxDepth {
		t.Fatalf("child depth = %d, want %d", childDepth, agent.SubtaskMaxDepth)
	}
}
