package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// nestedSpawnClient plays every level of a nested spawn chain: below leafDepth each level spawns
// the next with spawnTools, and the leaf calls probe. Each level then answers with the last tool
// result it saw, so the leaf's answer travels back up to the main task.
type nestedSpawnClient struct {
	leafDepth  int
	spawnTools []any
	// spawnToolsAt overrides spawnTools for the spawn made at a depth.
	spawnToolsAt map[int][]any
	// cancelAtLeaf cancels the run when the leaf makes its first request.
	cancelAtLeaf context.CancelFunc

	mu       sync.Mutex
	calls    map[int]int
	offered  map[int][]string
	maxDepth int
}

func (c *nestedSpawnClient) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	depth := SubtaskDepthFromContext(ctx)
	c.mu.Lock()
	if c.calls == nil {
		c.calls = map[int]int{}
		c.offered = map[int][]string{}
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
	}
	c.maxDepth = max(c.maxDepth, depth)
	c.mu.Unlock()

	if err := ctx.Err(); err != nil {
		return llm.Result{}, err
	}
	if call == 1 {
		if depth == c.leafDepth && c.cancelAtLeaf != nil {
			c.cancelAtLeaf()
			return llm.Result{}, context.Canceled
		}
		if depth < c.leafDepth {
			whitelist := c.spawnTools
			if at, ok := c.spawnToolsAt[depth]; ok {
				whitelist = at
			}
			return llm.Result{ToolCalls: []llm.ToolCall{{
				ID:        "spawn-call",
				Name:      spawnToolName,
				Arguments: map[string]any{"task": "nested work", "tools": whitelist},
			}}}, nil
		}
		return llm.Result{ToolCalls: []llm.ToolCall{{ID: "probe-call", Name: "probe", Arguments: map[string]any{}}}}, nil
	}
	output := "leaf done"
	if depth < c.leafDepth {
		output = lastToolMessage(req.Messages)
	}
	raw, _ := json.Marshal(map[string]any{"type": "final", "output": output})
	return llm.Result{Text: string(raw)}, nil
}

func (c *nestedSpawnClient) toolsAt(depth int) []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.offered[depth]
}

func lastToolMessage(messages []llm.Message) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "tool" {
			return messages[i].Content
		}
	}
	return ""
}

func nestedSpawnRegistry(t *testing.T, names ...string) *tools.Registry {
	t.Helper()
	reg := tools.NewRegistry()
	for _, name := range names {
		if err := reg.Register(stubSubtaskTool{name: name}); err != nil {
			t.Fatalf("Register(%s) error = %v", name, err)
		}
	}
	return reg
}

func TestLocalSubtaskRunnerNestsToMaxDepth(t *testing.T) {
	// The main task gives its child probe and spawn but not secret, so the child's own child
	// cannot get secret either, even when it asks for it.
	client := &nestedSpawnClient{leafDepth: SubtaskMaxDepth, spawnToolsAt: map[int][]any{
		0: {"probe", spawnToolName},
		1: {"probe", "secret", spawnToolName},
	}}
	reg := nestedSpawnRegistry(t, "probe", "secret")
	engine := New(client, reg, Config{MaxSteps: 4, DefaultModel: "test-model"}, DefaultPromptSpec())

	final, _, err := engine.Run(context.Background(), "root task", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if got := client.toolsAt(0); !slices.Equal(got, []string{"probe", "secret", spawnToolName}) {
		t.Fatalf("depth 0 tools = %v", got)
	}
	if got := client.toolsAt(1); !slices.Equal(got, []string{"probe", spawnToolName}) {
		t.Fatalf("depth 1 tools = %v, want probe and its own spawn", got)
	}
	if got := client.toolsAt(2); !slices.Equal(got, []string{"probe"}) {
		t.Fatalf("depth 2 tools = %v, want only probe (no further delegation)", got)
	}
	if client.maxDepth != SubtaskMaxDepth {
		t.Fatalf("deepest request depth = %d, want %d", client.maxDepth, SubtaskMaxDepth)
	}
	output, _ := final.Output.(string)
	var depth1 SubtaskResult
	if err := json.Unmarshal([]byte(output), &depth1); err != nil {
		t.Fatalf("root output is not the depth 1 envelope: %v, raw=%q", err, output)
	}
	if depth1.Status != SubtaskStatusDone {
		t.Fatalf("depth 1 status = %q (%s)", depth1.Status, depth1.Error)
	}
	var depth2 SubtaskResult
	if err := json.Unmarshal([]byte(depth1.Output.(string)), &depth2); err != nil {
		t.Fatalf("depth 1 output is not the depth 2 envelope: %v, raw=%v", err, depth1.Output)
	}
	if depth2.Status != SubtaskStatusDone || depth2.Output != "leaf done" {
		t.Fatalf("depth 2 result = %+v, want done with leaf output", depth2)
	}
	if depth1.Worker == nil || depth2.Worker == nil || depth1.Worker.ID == depth2.Worker.ID {
		t.Fatalf("workers = %+v / %+v, want distinct workers per level", depth1.Worker, depth2.Worker)
	}
}

func TestLocalSubtaskRunnerRespectsSpawnWhitelist(t *testing.T) {
	// Without spawn in its whitelist the child gets no delegation tool.
	client := &nestedSpawnClient{leafDepth: 1, spawnTools: []any{"probe"}}
	engine := New(client, nestedSpawnRegistry(t, "probe"), Config{MaxSteps: 4}, DefaultPromptSpec())
	if _, _, err := engine.Run(context.Background(), "root task", RunOptions{}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if got := client.toolsAt(1); !slices.Equal(got, []string{"probe"}) {
		t.Fatalf("depth 1 tools = %v, want only probe", got)
	}
}

func TestLocalSubtaskRunnerNestedCancellation(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client := &nestedSpawnClient{leafDepth: SubtaskMaxDepth, spawnTools: []any{"probe", spawnToolName}, cancelAtLeaf: cancel}
	engine := New(client, nestedSpawnRegistry(t, "probe"), Config{MaxSteps: 4}, DefaultPromptSpec())
	_, _, err := engine.Run(ctx, "root task", RunOptions{})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("Run() error = %v, want context.Canceled from the depth 2 subtask", err)
	}
	if got := client.toolsAt(2); got == nil {
		t.Fatal("cancellation test never reached depth 2")
	}
}

func TestLocalSubtaskRunnerDepthLimit(t *testing.T) {
	tests := []struct {
		depth   int
		allowed bool
	}{
		{depth: 0, allowed: true},
		{depth: 1, allowed: true},
		{depth: SubtaskMaxDepth, allowed: false},
	}
	for _, tt := range tests {
		t.Run(fmt.Sprintf("parent depth %d", tt.depth), func(t *testing.T) {
			engine := New(failingSubtaskClient{t: t}, tools.NewRegistry(), Config{DefaultModel: "gpt-5.2"}, DefaultPromptSpec())
			runner := &localSubtaskRunner{engine: engine}
			ctx := WithSubtaskDepth(context.Background(), tt.depth)

			childDepth := -1
			result, err := runner.RunSubtask(ctx, SubtaskRequest{
				RunFunc: func(runCtx context.Context) (*SubtaskResult, error) {
					childDepth = SubtaskDepthFromContext(runCtx)
					return &SubtaskResult{Status: SubtaskStatusDone, Output: "ok"}, nil
				},
			})
			if err != nil || result == nil {
				t.Fatalf("RunSubtask() = %+v, %v", result, err)
			}
			if !tt.allowed {
				if childDepth != -1 {
					t.Fatal("subtask beyond the depth limit ran its callback")
				}
				if result.Status != SubtaskStatusFailed || !strings.Contains(result.Error, "depth limit") {
					t.Fatalf("result = %+v, want failed depth limit", result)
				}
				// An agent subtask is rejected before it reaches the model.
				agentResult, err := runner.RunSubtask(ctx, SubtaskRequest{Task: "too deep", Registry: nestedSpawnRegistry(t, "probe")})
				if err != nil || agentResult == nil || agentResult.Status != SubtaskStatusFailed || !strings.Contains(agentResult.Error, "depth limit") {
					t.Fatalf("agent RunSubtask() = %+v, %v, want failed depth limit", agentResult, err)
				}
				return
			}
			if result.Status != SubtaskStatusDone {
				t.Fatalf("result = %+v, want done", result)
			}
			if childDepth != tt.depth+1 {
				t.Fatalf("child depth = %d, want %d", childDepth, tt.depth+1)
			}
		})
	}
}

func TestSubtaskCanSpawn(t *testing.T) {
	agentReq := SubtaskRequest{Task: "x", AllowSpawn: true}
	if !SubtaskCanSpawn(WithSubtaskDepth(context.Background(), 1), agentReq) {
		t.Fatal("depth 1 subtask with spawn whitelisted should get spawn")
	}
	if SubtaskCanSpawn(WithSubtaskDepth(context.Background(), SubtaskMaxDepth), agentReq) {
		t.Fatal("subtask at the depth limit must not get spawn")
	}
	if SubtaskCanSpawn(WithSubtaskDepth(context.Background(), 1), SubtaskRequest{Task: "x"}) {
		t.Fatal("subtask without spawn whitelisted must not get spawn")
	}
}

func TestSpawnToolPassesSpawnWhitelistToRunner(t *testing.T) {
	runner := &stubSubtaskRunner{result: &SubtaskResult{Status: SubtaskStatusDone}}
	engine := New(noopSubtaskClient{}, nestedSpawnRegistry(t, "probe"), Config{}, DefaultPromptSpec(), WithSubtaskRunner(runner))
	tool, _ := engine.registry.Get(spawnToolName)
	for _, tt := range []struct {
		tools []any
		want  bool
	}{
		{tools: []any{"probe"}, want: false},
		{tools: []any{"probe", "spawn"}, want: true},
	} {
		if _, err := tool.Execute(context.Background(), map[string]any{"task": "x", "tools": tt.tools}); err != nil {
			t.Fatalf("Execute(%v) error = %v", tt.tools, err)
		}
		if runner.req.AllowSpawn != tt.want {
			t.Fatalf("tools %v: AllowSpawn = %v, want %v", tt.tools, runner.req.AllowSpawn, tt.want)
		}
		if names := runner.req.Registry.ToolNames(); names != "probe" {
			t.Fatalf("tools %v: child registry = %q, want probe (spawn is never copied)", tt.tools, names)
		}
	}
}

func TestCurrentModelProfileLister(t *testing.T) {
	list := func(context.Context) ([]ModelProfile, error) {
		return []ModelProfile{{Name: "default", Current: true}, {Name: "fast"}}, nil
	}
	profiles, err := currentModelProfileLister(list, "fast")(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if profiles[0].Current || !profiles[1].Current {
		t.Fatalf("profiles = %+v, want fast current", profiles)
	}
	if got := currentModelProfileLister(list, ""); got == nil {
		t.Fatal("empty profile should keep the parent's lister")
	}
}

type failingSubtaskClient struct{ t *testing.T }

func (c failingSubtaskClient) Chat(context.Context, llm.Request) (llm.Result, error) {
	c.t.Fatal("subtask beyond the depth limit reached the model")
	return llm.Result{}, nil
}
