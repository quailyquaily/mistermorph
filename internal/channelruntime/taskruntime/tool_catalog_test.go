package taskruntime

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/internal/contextcheckpoint"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/internal/mcphost"
	"github.com/quailyquaily/mistermorph/internal/runtimepaths"
	"github.com/quailyquaily/mistermorph/internal/toolsutil"
	"github.com/quailyquaily/mistermorph/internal/topiccontext"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/spf13/viper"
)

// localMCPServer serves the named tools over streamable HTTP and counts requests.
func localMCPServer(t *testing.T, toolNames ...string) (string, *atomic.Int64) {
	t.Helper()
	server := mcp.NewServer(&mcp.Implementation{Name: "test", Version: "1.0"}, nil)
	for _, name := range toolNames {
		mcp.AddTool(server, &mcp.Tool{Name: name, Description: "Tool " + strings.ReplaceAll(name, "_", " ")}, func(context.Context, *mcp.CallToolRequest, struct{}) (*mcp.CallToolResult, struct{}, error) {
			return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: "ok"}}}, struct{}{}, nil
		})
	}
	handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server }, nil)
	requests := &atomic.Int64{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(ts.Close)
	return ts.URL, requests
}

func onDemandStatus(name, url, description string) mcphost.ServerStatus {
	return mcphost.ServerStatus{
		Config: mcphost.ServerConfig{Name: name, Enable: true, OnDemand: true, Type: "http", URL: url, Description: description},
		State:  mcphost.ServerOnDemand,
	}
}

func TestRunToolCatalog(t *testing.T) {
	url, requests := localMCPServer(t, "search_tickets", "delete_project")
	servers := []mcphost.ServerStatus{
		onDemandStatus("jira", url, "Search tickets in Jira."),
		{Config: mcphost.ServerConfig{Name: "off", Enable: false}, State: mcphost.ServerDisabled},
		{Config: mcphost.ServerConfig{Name: "dup", Enable: true}, State: mcphost.ServerInvalid, Err: context.Canceled},
	}
	catalog := newRunToolCatalog(tools.NewRegistry(), servers, nil)
	defer catalog.Close()

	listed := catalog.Servers()
	if len(listed) != 1 || listed[0].Name != "jira" || listed[0].Connected || listed[0].Description != "Search tickets in Jira." {
		t.Fatalf("servers = %+v, want only jira, not connected", listed)
	}
	if requests.Load() != 0 {
		t.Fatal("listing servers contacted one")
	}

	first, err := catalog.ConnectServer(context.Background(), "JIRA")
	if err != nil || len(first) != 2 {
		t.Fatalf("connect = %v, %v", first, err)
	}
	afterFirst := requests.Load()
	if _, err := catalog.ConnectServer(context.Background(), "jira"); err != nil || requests.Load() != afterFirst {
		t.Fatalf("second connect err = %v, requests %d → %d; want the run's connection reused", err, afterFirst, requests.Load())
	}
	if got := catalog.ServerOfTool("mcp_jira__search_tickets"); got != "jira" {
		t.Fatalf("ServerOfTool = %q", got)
	}
	if loaded := catalog.LoadTools(context.Background(), []string{"mcp_jira__search_tickets", "mcp_gone__x"}); len(loaded) != 1 {
		t.Fatalf("LoadTools = %v, want the one known tool", loaded)
	}
	for _, name := range []string{"off", "dup", "unknown"} {
		if _, err := catalog.ConnectServer(context.Background(), name); err == nil {
			t.Fatalf("connect %s: want an error", name)
		}
	}
}

func TestToolSearchOption(t *testing.T) {
	cfg := toolsutil.ToolSearchConfig{Enabled: true}
	if opt, _, err := ToolSearchOption(tools.NewRegistry(), nil, toolsutil.ToolSearchConfig{}, nil, nil); opt != nil || err != nil {
		t.Fatal("tool search off: want no option")
	}
	if opt, _, err := ToolSearchOption(tools.NewRegistry(), nil, cfg, nil, nil); opt != nil || err != nil {
		t.Fatal("nothing to hide: want no option")
	}
	conflict := tools.NewRegistry()
	_ = conflict.Register(namedTool{name: "tool_search"})
	if _, _, err := ToolSearchOption(conflict, []mcphost.ServerStatus{onDemandStatus("jira", "http://127.0.0.1:1", "")}, cfg, nil, nil); err == nil {
		t.Fatal("a registered tool_search: want a preparation error")
	}
	if opt, _, err := ToolSearchOption(tools.NewRegistry(), []mcphost.ServerStatus{onDemandStatus("jira", "http://127.0.0.1:1", "")}, cfg, nil, nil); opt == nil || err != nil {
		t.Fatalf("on-demand server: option = %v, err = %v; want tool search on", opt != nil, err)
	}
}

type namedTool struct{ name string }

func (t namedTool) Name() string          { return t.name }
func (namedTool) Description() string     { return "stub" }
func (namedTool) ParameterSchema() string { return `{}` }
func (namedTool) Execute(context.Context, map[string]any) (string, error) {
	return "ok", nil
}

// scriptedClient answers with the given results in order and records requests.
type scriptedClient struct {
	results  []llm.Result
	requests []llm.Request
}

func (c *scriptedClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.requests = append(c.requests, req)
	if len(c.requests) > len(c.results) {
		return llm.Result{Text: `{"type":"final","output":"done"}`}, nil
	}
	return c.results[len(c.requests)-1], nil
}

func requestTools(req llm.Request) string {
	var names []string
	for _, tool := range req.Tools {
		names = append(names, tool.Name)
	}
	return strings.Join(names, ",")
}

func TestRunRemembersFoundToolsForTheConversation(t *testing.T) {
	url, _ := localMCPServer(t, "search_tickets", "delete_project")
	stateDir := t.TempDir()
	route := llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "gpt-5.2"}}
	newRuntime := func(client *scriptedClient) *Runtime {
		t.Helper()
		rt, err := Bootstrap(depsutil.CommonDependencies{
			Logger:          func() (*slog.Logger, error) { return slog.Default(), nil },
			LogOptions:      func() agent.LogOptions { return agent.LogOptions{} },
			ResolveLLMRoute: func(string) (llmutil.ResolvedRoute, error) { return route, nil },
			CreateLLMClient: func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil },
			Registry:        func() *tools.Registry { return tools.NewRegistry() },
			MCPServers:      []mcphost.ServerStatus{onDemandStatus("jira", url, "Search tickets in Jira.")},
			RuntimeToolsConfig: toolsutil.RuntimeToolsRegisterConfig{
				ToolSearch: toolsutil.ToolSearchConfig{Enabled: true},
			},
			RuntimePaths: runtimepaths.Paths{CheckpointRoot: stateDir},
			PromptSpec: func(_ context.Context, _ *slog.Logger, _ agent.LogOptions, _ string, _ llm.Client, _ string, _ []string) (agent.PromptSpec, []string, error) {
				return agent.DefaultPromptSpec(), nil, nil
			},
		}, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 5}})
		if err != nil {
			t.Fatalf("Bootstrap() error = %v", err)
		}
		return rt
	}
	ctx := topiccontext.WithScope(context.Background(), topiccontext.Scope{Runtime: "test", ConversationKey: "tg:42"})

	first := &scriptedClient{results: []llm.Result{
		{ToolCalls: []llm.ToolCall{{ID: "1", Name: "tool_search", Arguments: map[string]any{"query": "search tickets", "server": "jira"}}}},
		{ToolCalls: []llm.ToolCall{{ID: "2", Name: "mcp_jira__search_tickets", Arguments: map[string]any{}}}},
	}}
	if _, err := newRuntime(first).Run(ctx, RunRequest{Task: "find the login ticket"}); err != nil {
		t.Fatalf("first run: %v", err)
	}
	if got := requestTools(first.requests[0]); strings.Contains(got, "mcp_jira") || !strings.Contains(got, "tool_search") {
		t.Fatalf("first request tools = %s, want tool_search and no MCP tools", got)
	}
	if got := requestTools(first.requests[1]); !strings.Contains(got, "mcp_jira__search_tickets") || strings.Contains(got, "delete_project") {
		t.Fatalf("after search tools = %s, want only the found tool", got)
	}
	saved, _ := contextcheckpoint.LoadFoundTools(stateDir, "tg:42")
	if len(saved) != 1 || saved[0] != "mcp_jira__search_tickets" {
		t.Fatalf("saved found tools = %v", saved)
	}

	second := &scriptedClient{}
	if _, err := newRuntime(second).Run(ctx, RunRequest{Task: "and the next one"}); err != nil {
		t.Fatalf("second run: %v", err)
	}
	if got := requestTools(second.requests[0]); !strings.Contains(got, "mcp_jira__search_tickets") || strings.Contains(got, "delete_project") {
		t.Fatalf("next message's first request tools = %s, want the remembered tool", got)
	}

	if err := contextcheckpoint.Reset(context.Background(), stateDir, "tg:42"); err != nil {
		t.Fatal(err)
	}
	third := &scriptedClient{}
	if _, err := newRuntime(third).Run(ctx, RunRequest{Task: "after reset"}); err != nil {
		t.Fatalf("third run: %v", err)
	}
	if got := requestTools(third.requests[0]); strings.Contains(got, "mcp_jira") {
		t.Fatalf("after /reset tools = %s, want the remembered tool gone", got)
	}
}

func TestToolSearchDefaultsOnAndStaysOutWithoutMCP(t *testing.T) {
	reader := viper.New()
	configdefaults.Apply(reader)
	cfg := toolsutil.LoadRuntimeToolsRegisterConfigFromReader(reader)
	if !cfg.ToolSearch.Enabled {
		t.Fatal("tools.tool_search.enabled defaults to off, want on")
	}

	route := llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "gpt-5.2"}}
	client := &scriptedClient{}
	rt, err := Bootstrap(depsutil.CommonDependencies{
		Logger:             func() (*slog.Logger, error) { return slog.Default(), nil },
		LogOptions:         func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute:    func(string) (llmutil.ResolvedRoute, error) { return route, nil },
		CreateLLMClient:    func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil },
		Registry:           func() *tools.Registry { return tools.NewRegistry() },
		RuntimeToolsConfig: cfg,
		PromptSpec: func(_ context.Context, _ *slog.Logger, _ agent.LogOptions, _ string, _ llm.Client, _ string, _ []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
	}, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 2}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := rt.Run(context.Background(), RunRequest{Task: "hello"}); err != nil {
		t.Fatal(err)
	}
	if got := requestTools(client.requests[0]); strings.Contains(got, "tool_search") {
		t.Fatalf("no MCP configured, but tools = %s", got)
	}
	if strings.Contains(client.requests[0].Messages[0].Content, "[[ Tool Search ]]") {
		t.Fatal("no MCP configured, but the prompt has the tool search block")
	}
}
