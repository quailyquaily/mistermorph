package agent

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

type searchTestTool struct {
	name, description string
	calls             *int
}

func (t searchTestTool) Name() string            { return t.name }
func (t searchTestTool) Description() string     { return t.description }
func (t searchTestTool) ParameterSchema() string { return `{"type":"object"}` }
func (t searchTestTool) Execute(context.Context, map[string]any) (string, error) {
	if t.calls != nil {
		*t.calls++
	}
	return "ran " + t.name, nil
}

type fakeCatalog struct {
	mu       sync.Mutex
	servers  []CatalogServer
	byServer map[string][]tools.Tool
	connects map[string]int
}

func (c *fakeCatalog) Servers() []CatalogServer { return c.servers }

func (c *fakeCatalog) ConnectServer(_ context.Context, name string) ([]tools.Tool, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.connects == nil {
		c.connects = map[string]int{}
	}
	ts, ok := c.byServer[strings.ToLower(name)]
	if !ok {
		return nil, errNoServer(name)
	}
	c.connects[strings.ToLower(name)]++
	return ts, nil
}

func (c *fakeCatalog) LoadTools(ctx context.Context, names []string) []tools.Tool {
	var out []tools.Tool
	for _, name := range names {
		for server := range c.byServer {
			if !strings.HasPrefix(name, "mcp_"+server+"__") {
				continue
			}
			ts, _ := c.ConnectServer(ctx, server)
			for _, tool := range ts {
				if tool.Name() == name {
					out = append(out, tool)
				}
			}
		}
	}
	return out
}

func (c *fakeCatalog) ServerOfTool(name string) string {
	for server := range c.byServer {
		if strings.HasPrefix(name, "mcp_"+server+"__") {
			return server
		}
	}
	return ""
}

type errNoServer string

func (e errNoServer) Error() string { return "mcp server " + string(e) + " is not available" }

func isMCP(tool tools.Tool) bool { return strings.HasPrefix(tool.Name(), "mcp_") }

// searchFixture: one built-in tool, two tools of a server connected at startup (in the registry),
// and an on-demand server whose tools only the catalog has.
func searchFixture() (*tools.Registry, *fakeCatalog, *int) {
	issueCalls := 0
	reg := tools.NewRegistry()
	_ = reg.Register(searchTestTool{name: "read_file", description: "Read a file."})
	_ = reg.Register(searchTestTool{name: "mcp_live__get_issue", description: "Get an issue by number.", calls: &issueCalls})
	_ = reg.Register(searchTestTool{name: "mcp_live__list_repos", description: "List repositories."})
	catalog := &fakeCatalog{
		servers: []CatalogServer{
			{Name: "live", Description: "Work GitHub account.", Connected: true},
			{Name: "jira", Description: "Search tickets in the Jira project."},
		},
		byServer: map[string][]tools.Tool{
			"live": {reg.All()[0], reg.All()[1]},
			"jira": {
				searchTestTool{name: "mcp_jira__search_tickets", description: "Search tickets."},
				searchTestTool{name: "mcp_jira__delete_project", description: "Delete a project."},
			},
		},
	}
	// Keep byServer["live"] to the registry's MCP tools regardless of map order.
	liveTools := []tools.Tool{}
	for _, tool := range reg.All() {
		if strings.HasPrefix(tool.Name(), "mcp_live__") {
			liveTools = append(liveTools, tool)
		}
	}
	catalog.byServer["live"] = liveTools
	return reg, catalog, &issueCalls
}

func toolCall(name string, args map[string]any) llm.Result {
	return llm.Result{ToolCalls: []llm.ToolCall{{ID: name, Name: name, Arguments: args}}}
}

func requestToolNames(req llm.Request) string {
	names := make([]string, 0, len(req.Tools))
	for _, tool := range req.Tools {
		names = append(names, tool.Name)
	}
	return strings.Join(names, ",")
}

func TestToolSearchHidesMCPToolsUntilFound(t *testing.T) {
	reg, catalog, issueCalls := searchFixture()
	client := newMockClient(
		// Step 0: search, and guess the tool in the same response; the guess is rejected.
		llm.Result{ToolCalls: []llm.ToolCall{
			{ID: "s", Name: "tool_search", Arguments: map[string]any{"query": "get issue"}},
			{ID: "g", Name: "mcp_live__get_issue", Arguments: map[string]any{}},
		}},
		// Step 1: the found tool is callable now.
		toolCall("mcp_live__get_issue", map[string]any{}),
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 5}, DefaultPromptSpec(), WithToolSearch(ToolSearchOptions{Catalog: catalog, Hidden: isMCP}))
	_, runCtx, err := engine.Run(context.Background(), "find the issue", RunOptions{})
	if err != nil {
		t.Fatal(err)
	}

	first := client.calls[0]
	if got := requestToolNames(first); strings.Contains(got, "mcp_") || !strings.Contains(got, "tool_search") || !strings.Contains(got, "read_file") {
		t.Fatalf("first request tools = %s, want built-ins and tool_search only", got)
	}
	system := first.Messages[0].Content
	if strings.Contains(system, "mcp_live__get_issue") || !strings.Contains(system, "[[ Tool Search ]]") {
		t.Fatalf("system prompt lists hidden tools or lacks the tool search block:\n%s", system)
	}
	if got := requestToolNames(client.calls[1]); !strings.Contains(got, "mcp_live__get_issue") || strings.Contains(got, "list_repos") {
		t.Fatalf("second request tools = %s, want the found tool only", got)
	}
	if *issueCalls != 1 {
		t.Fatalf("get_issue ran %d times, want once (the same-step guess is rejected)", *issueCalls)
	}
	guess := lastToolObservation(client.calls[1], "g")
	if !strings.Contains(guess, "tool_search") {
		t.Fatalf("rejected guess observation = %q, want a pointer to tool_search", guess)
	}
	if len(runCtx.FoundTools) == 0 || runCtx.FoundTools[0] != "mcp_live__get_issue" {
		t.Fatalf("found tools = %v, want mcp_live__get_issue", runCtx.FoundTools)
	}
}

func lastToolObservation(req llm.Request, callID string) string {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		m := req.Messages[i]
		if m.Role == "tool" && m.ToolCallID == callID {
			return m.Content
		}
	}
	return ""
}

func TestToolSearchServers(t *testing.T) {
	reg, catalog, _ := searchFixture()
	client := newMockClient(
		toolCall("tool_search", map[string]any{"query": "jira tickets"}),
		toolCall("tool_search", map[string]any{"query": "search tickets", "server": "JIRA"}),
		toolCall("tool_search", map[string]any{"query": "search", "server": "jira"}),
		toolCall("mcp_jira__search_tickets", map[string]any{}),
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithToolSearch(ToolSearchOptions{Catalog: catalog, Hidden: isMCP}))
	if _, _, err := engine.Run(context.Background(), "find tickets", RunOptions{}); err != nil {
		t.Fatal(err)
	}

	var global toolSearchOutput
	if err := json.Unmarshal([]byte(lastToolObservation(client.calls[1], "tool_search")), &global); err != nil {
		t.Fatal(err)
	}
	if len(global.Servers) != 1 || global.Servers[0].Name != "jira" || global.Servers[0].Connected {
		t.Fatalf("global search = %+v, want the jira server, not connected", global)
	}
	if got := requestToolNames(client.calls[2]); !strings.Contains(got, "mcp_jira__search_tickets") || strings.Contains(got, "delete_project") {
		t.Fatalf("after scoped search tools = %s, want only the matching tool", got)
	}
	if got := requestToolNames(client.calls[3]); strings.Count(got, "mcp_jira__search_tickets") != 1 {
		t.Fatalf("repeated search duplicated a tool: %s", got)
	}
}

func TestToolSearchCapsFoundTools(t *testing.T) {
	reg, catalog, _ := searchFixture()
	client := newMockClient(
		toolCall("tool_search", map[string]any{"query": "mcp_live__get_issue"}),
		toolCall("tool_search", map[string]any{"query": "list repositories"}),
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 5}, DefaultPromptSpec(), WithToolSearch(ToolSearchOptions{Catalog: catalog, Hidden: isMCP, MaxFound: 1}))
	if _, _, err := engine.Run(context.Background(), "x", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	var second toolSearchOutput
	_ = json.Unmarshal([]byte(lastToolObservation(client.calls[2], "tool_search")), &second)
	if len(second.Tools) != 0 || second.Note == "" {
		t.Fatalf("over the cap: %+v, want no tools and a note", second)
	}
	if got := requestToolNames(client.calls[2]); strings.Contains(got, "list_repos") {
		t.Fatalf("tools over the cap became visible: %s", got)
	}
}

func TestToolSearchInitialVisibleAndRestore(t *testing.T) {
	reg, catalog, _ := searchFixture()
	client := newMockClient(finalResponse("done"))
	engine := New(client, reg, Config{MaxSteps: 2}, DefaultPromptSpec(), WithToolSearch(ToolSearchOptions{
		Catalog: catalog, Hidden: isMCP,
		// One tool in the registry, one the catalog must load, one that no longer exists.
		Visible: []string{"mcp_live__list_repos", "mcp_jira__search_tickets", "mcp_gone__tool"},
	}))
	if _, _, err := engine.Run(context.Background(), "x", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	got := requestToolNames(client.calls[0])
	if !strings.Contains(got, "mcp_live__list_repos") || !strings.Contains(got, "mcp_jira__search_tickets") || strings.Contains(got, "get_issue") || strings.Contains(got, "gone") {
		t.Fatalf("first request tools = %s, want the two available initial tools only", got)
	}
}

func TestToolSearchOffKeepsEverythingVisible(t *testing.T) {
	reg, _, _ := searchFixture()
	client := newMockClient(toolCall("missing", nil), finalResponse("done"))
	engine := New(client, reg, Config{MaxSteps: 3}, DefaultPromptSpec())
	if _, _, err := engine.Run(context.Background(), "x", RunOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := requestToolNames(client.calls[0]); !strings.Contains(got, "mcp_live__get_issue") || strings.Contains(got, "tool_search") {
		t.Fatalf("tools = %s, want every registered tool and no tool_search", got)
	}
	if obs := lastToolObservation(client.calls[1], "missing"); !strings.Contains(obs, "not found. Available tools:") || strings.Contains(obs, "tool_search") {
		t.Fatalf("unknown-tool error changed: %q", obs)
	}
}

func TestSubtasksNeverGetHiddenTools(t *testing.T) {
	reg, catalog, _ := searchFixture()
	engine := New(newMockClient(), reg, Config{}, DefaultPromptSpec(), WithToolSearch(ToolSearchOptions{Catalog: catalog, Hidden: isMCP}))
	if _, ok := engine.lookupSubtaskTool("mcp_live__get_issue"); ok {
		t.Fatal("a hidden tool was handed to a subtask")
	}
	if _, ok := engine.lookupSubtaskTool("tool_search"); ok {
		t.Fatal("tool_search was handed to a subtask")
	}
	if _, ok := engine.lookupSubtaskTool("read_file"); !ok {
		t.Fatal("a built-in tool was withheld from a subtask")
	}
}

func TestMatchText(t *testing.T) {
	tests := []struct {
		query, name, description string
		class                    int
		ok                       bool
	}{
		{"mcp_live__get_issue", "mcp_live__get_issue", "", 0, true},
		{"MCP_LIVE", "mcp_live__get_issue", "", 1, true},
		{"get issue", "mcp_live__get_issue", "", 2, true},
		{"issue tracker", "mcp_live__get_issue", "Get an issue.", 3, true},
		{"課題", "mcp_x__find", "課題を検索する", 2, true},
		{"weather", "mcp_live__get_issue", "Get an issue.", 0, false},
	}
	for _, tt := range tests {
		class, _, ok := matchText(tt.query, tt.name, tt.description)
		if ok != tt.ok || (ok && class != tt.class) {
			t.Errorf("matchText(%q, %q) = %d, %v; want %d, %v", tt.query, tt.name, class, ok, tt.class, tt.ok)
		}
	}
}

func TestToolSearchPromptNamesServersNotTools(t *testing.T) {
	_, catalog, _ := searchFixture()
	prompt := toolSearchPrompt(catalog)
	if !strings.Contains(prompt, "  - jira: Search tickets in the Jira project.") || !strings.Contains(prompt, "  - live: Work GitHub account.") {
		t.Fatalf("prompt does not name the servers:\n%s", prompt)
	}
	if strings.Contains(prompt, "mcp_") {
		t.Fatalf("prompt names tools:\n%s", prompt)
	}
}
