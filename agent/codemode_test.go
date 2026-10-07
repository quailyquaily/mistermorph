package agent

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type codeTestTool struct {
	name   string
	result func(map[string]any) string
	safe   bool
	mu     *sync.Mutex
	calls  *[]map[string]any
}

func (t codeTestTool) Name() string        { return t.name }
func (t codeTestTool) Description() string { return "Test tool " + t.name + "." }
func (t codeTestTool) ParameterSchema() string {
	return `{"type":"object","properties":{"path":{"type":"string"}}}`
}
func (t codeTestTool) ParallelSafe() bool { return t.safe }
func (t codeTestTool) Execute(_ context.Context, params map[string]any) (string, error) {
	if t.calls != nil {
		t.mu.Lock()
		*t.calls = append(*t.calls, params)
		t.mu.Unlock()
	}
	if t.result != nil {
		return t.result(params), nil
	}
	return "ran " + t.name, nil
}

type codeTestFixture struct {
	reg   *tools.Registry
	mu    sync.Mutex
	calls []map[string]any
}

func newCodeTestFixture() *codeTestFixture {
	f := &codeTestFixture{reg: tools.NewRegistry()}
	_ = f.reg.Register(codeTestTool{name: "read_file", safe: true, mu: &f.mu, calls: &f.calls, result: func(p map[string]any) string {
		return "content of " + p["path"].(string)
	}})
	_ = f.reg.Register(codeTestTool{name: "bash"})
	_ = f.reg.Register(codeTestTool{name: "plan_create"})
	_ = f.reg.Register(codeTestTool{name: "url_fetch", result: func(p map[string]any) string { return "fetched " + p["url"].(string) }})
	return f
}

func codeCall(code string) llm.Result {
	return llm.Result{ToolCalls: []llm.ToolCall{{ID: "cm", Name: "codemode", Arguments: map[string]any{"code": code}}}}
}

func codeObservation(t *testing.T, req llm.Request) codeModeObservation {
	t.Helper()
	var out codeModeObservation
	raw := lastToolObservation(req, "cm")
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("observation %q: %v", raw, err)
	}
	return out
}

func TestCodeModeRunsToolsInOneStep(t *testing.T) {
	f := newCodeTestFixture()
	client := newMockClient(
		codeCall(`const a = await tools.read_file({path: "a.txt"}); const b = await tools.read_file({path: a.slice(-5)}); return b.length`),
		finalResponse("done"),
	)
	engine := New(client, f.reg, Config{MaxSteps: 4}, DefaultPromptSpec(), WithCodeMode(CodeModeOptions{}))
	if _, _, err := engine.Run(context.Background(), "x", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if len(client.calls) != 2 {
		t.Fatalf("model requests = %d, want 2", len(client.calls))
	}
	first := client.calls[0]
	if got := requestToolNames(first); !strings.Contains(got, "codemode") {
		t.Fatalf("tools = %s, want codemode", got)
	}
	if !strings.Contains(first.Messages[0].Content, "[[ Code Mode ]]") {
		t.Fatalf("system prompt lacks the Code Mode block")
	}
	out := codeObservation(t, client.calls[1])
	if out.Status != "completed" || len(out.Output) != 1 || out.Output[0] != "16" {
		t.Fatalf("observation = %+v", out)
	}
	if len(f.calls) != 2 || f.calls[1]["path"] != "a.txt" {
		t.Fatalf("calls = %v; the second read must get the first result", f.calls)
	}
	for _, m := range client.calls[1].Messages {
		if m.Role == "tool" && strings.Contains(m.Content, "content of a.txt") {
			t.Fatalf("an intermediate result reached the model: %q", m.Content)
		}
	}
}

func TestCodeModeDisabled(t *testing.T) {
	f := newCodeTestFixture()
	client := newMockClient(finalResponse("done"))
	engine := New(client, f.reg, Config{MaxSteps: 2}, DefaultPromptSpec())
	if _, _, err := engine.Run(context.Background(), "x", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := requestToolNames(client.calls[0]); strings.Contains(got, "codemode") || strings.Contains(client.calls[0].Messages[0].Content, "Code Mode") {
		t.Fatalf("codemode offered without the option: %s", got)
	}
}

func TestCodeModeExcludedTools(t *testing.T) {
	f := newCodeTestFixture()
	client := newMockClient(
		codeCall(`const out = []; for (const name of ["bash", "plan_create", "tool_search", "codemode", "nope"]) { try { await tools[name]({}) } catch (e) { out.push(e.message) } } const found = await searchTools("bash plan"); out.push(found.tools.map(t => t.name).join(",")); return out`),
		finalResponse("done"),
	)
	engine := New(client, f.reg, Config{MaxSteps: 4}, DefaultPromptSpec(), WithCodeMode(CodeModeOptions{}))
	if _, _, err := engine.Run(context.Background(), "x", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	out := codeObservation(t, client.calls[1])
	var messages []string
	_ = json.Unmarshal([]byte(out.Output[0]), &messages)
	for i, name := range []string{"bash", "plan_create", "tool_search", "codemode"} {
		if !strings.Contains(messages[i], name) || !strings.Contains(messages[i], "call it directly") && !strings.Contains(messages[i], "not available") {
			t.Fatalf("%s: %q", name, messages[i])
		}
	}
	if !strings.Contains(messages[4], "not available") {
		t.Fatalf("unknown tool: %q", messages[4])
	}
	if messages[5] != "" {
		t.Fatalf("search found excluded tools: %q", messages[5])
	}
}

func TestCodeModeFindsHiddenToolsForTheScriptOnly(t *testing.T) {
	reg, catalog, _ := searchFixture()
	client := newMockClient(
		codeCall(`let guessed; try { await tools.mcp_live__get_issue({}) } catch (e) { guessed = e.message } const found = await searchTools("search tickets", {server: "jira"}); const r = await tools[found.tools[0].name]({}); return [guessed, r]`),
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 4}, DefaultPromptSpec(),
		WithToolSearch(ToolSearchOptions{Catalog: catalog, Hidden: isMCP}), WithCodeMode(CodeModeOptions{}))
	_, runCtx, err := engine.Run(context.Background(), "x", RunOptions{})
	if err != nil {
		t.Fatal(err)
	}
	out := codeObservation(t, client.calls[1])
	if out.Status != "completed" || !strings.Contains(out.Output[0], "not available") || !strings.Contains(out.Output[0], "ran mcp_jira__search_tickets") {
		t.Fatalf("observation = %+v", out)
	}
	if got := requestToolNames(client.calls[1]); strings.Contains(got, "mcp_") {
		t.Fatalf("a tool the script found became visible to the model: %s", got)
	}
	if len(runCtx.FoundTools) != 0 {
		t.Fatalf("found tools = %v; a script must not make tools sticky", runCtx.FoundTools)
	}
}

func TestCodeModeUsesTheRunsLimitsGuardHooksAndEvents(t *testing.T) {
	f := newCodeTestFixture()
	client := newMockClient(
		codeCall(`const out = []; for (const p of ["a", "b", "c"]) { try { out.push(await tools.read_file({path: p})) } catch (e) { out.push(e.message) } } try { await tools.url_fetch({url: "https://evil.example/x"}) } catch (e) { out.push(e.message) } out.push(await tools.url_fetch({url: "https://ok.example/x"})); return out`),
		finalResponse("done"),
	)
	g := guard.New(guard.Config{Enabled: true, Network: guard.NetworkConfig{URLFetch: guard.URLFetchNetworkPolicy{AllowedURLPrefixes: []string{"https://ok.example/"}}}}, nil, nil)
	var starts []ToolCall
	var dones []string
	sink := &recordingSink{}
	engine := New(client, f.reg, Config{MaxSteps: 4, ToolRepeatLimit: 2}, DefaultPromptSpec(), WithCodeMode(CodeModeOptions{}), WithGuard(g),
		WithOnToolCallStart(func(_ *Context, call ToolCall) { starts = append(starts, call) }),
		WithOnToolCallDone(func(_ *Context, call ToolCall, _ string, _ error) { dones = append(dones, call.Name) }))
	if _, _, err := engine.Run(WithEventSinkContext(context.Background(), sink), "x", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	out := codeObservation(t, client.calls[1])
	var results []string
	_ = json.Unmarshal([]byte(out.Output[0]), &results)
	if len(results) != 5 || results[0] != "content of a" || !strings.Contains(results[2], "ERR_TOOL_REPEAT_LIMIT") || !strings.Contains(results[3], "blocked by guard") || results[4] != "fetched https://ok.example/x" {
		t.Fatalf("results = %q", results)
	}
	// Hooks: the codemode call itself, then each nested call that ran, marked with its parent.
	if len(starts) != 4 || starts[0].Name != "codemode" || starts[1].ParentID == "" || starts[1].ParentID != toolActivityID(1, &starts[0]) {
		t.Fatalf("hook starts = %+v", starts)
	}
	if strings.Join(dones, ",") != "read_file,read_file,url_fetch,codemode" {
		t.Fatalf("hook dones = %v", dones)
	}
	nested := 0
	for _, ev := range sink.events {
		if ev.Kind == EventKindToolStart && ev.ParentActivityID != "" {
			nested++
		}
	}
	if nested != 3 {
		t.Fatalf("nested start events = %d, want 3", nested)
	}
}

type recordingSink struct {
	mu     sync.Mutex
	events []Event
}

func (s *recordingSink) HandleEvent(_ context.Context, ev Event) {
	s.mu.Lock()
	s.events = append(s.events, ev)
	s.mu.Unlock()
}

func TestCodeModeIsNotGivenToSubtasks(t *testing.T) {
	f := newCodeTestFixture()
	engine := New(newMockClient(), f.reg, Config{}, DefaultPromptSpec(), WithCodeMode(CodeModeOptions{}))
	if _, ok := engine.lookupSubtaskTool("codemode"); ok {
		t.Fatal("subtasks can get codemode")
	}
	if _, ok := engine.lookupSubtaskTool("read_file"); !ok {
		t.Fatal("subtasks lost read_file")
	}
}

func TestCodeModeFailureKeepsObservation(t *testing.T) {
	f := newCodeTestFixture()
	client := newMockClient(codeCall(`const x = ;`), finalResponse("done"))
	engine := New(client, f.reg, Config{MaxSteps: 4}, DefaultPromptSpec(), WithCodeMode(CodeModeOptions{}))
	if _, _, err := engine.Run(context.Background(), "x", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	out := codeObservation(t, client.calls[1])
	if out.Status != "failed" || !strings.Contains(out.Error, "line 1") {
		t.Fatalf("observation = %+v", out)
	}
}
