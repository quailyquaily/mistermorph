package runtimetest

import (
	"context"
	"io"
	"log/slog"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/taskruntime"
	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

// ConfigToolsDiscovery is what the model saw of config_get and config_set in one ordinary run
// that searched for "config", and what the runtime's awareness registry holds.
type ConfigToolsDiscovery struct {
	// InitiallyVisible: either tool was in the first request.
	InitiallyVisible bool
	// SearchOffered: tool_search was in the first request.
	SearchOffered bool
	// FoundGet, FoundSet: tool_search returned the tool.
	FoundGet, FoundSet bool
	// AwarenessGet, AwarenessSet: the awareness registry (heartbeat, scheduled jobs) has the tool.
	AwarenessGet, AwarenessSet bool
}

// DiscoverConfigTools runs one ordinary task through deps, as DiscoverContactsSend does, with a
// model that searches for "config" and then ends. Nothing is changed.
func DiscoverConfigTools(t testing.TB, deps depsutil.CommonDependencies) ConfigToolsDiscovery {
	t.Helper()
	var out ConfigToolsDiscovery
	if deps.AwarenessRegistry != nil {
		if reg := deps.AwarenessRegistry(); reg != nil {
			_, out.AwarenessGet = reg.Get("config_get")
			_, out.AwarenessSet = reg.Get("config_set")
		}
	}
	client := &configSearchingClient{}
	route := llmutil.ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "gpt-5.2"}}
	deps.Logger = func() (*slog.Logger, error) { return slog.New(slog.NewTextHandler(io.Discard, nil)), nil }
	deps.LogOptions = func() agent.LogOptions { return agent.LogOptions{} }
	deps.ResolveLLMRoute = func(string) (llmutil.ResolvedRoute, error) { return route, nil }
	deps.ResolveLLMRouteWithProfile = nil
	deps.CreateLLMClient = func(llmutil.ResolvedRoute) (llm.Client, error) { return client, nil }
	deps.PromptSpec = func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
		return agent.DefaultPromptSpec(), nil, nil
	}
	rt, err := taskruntime.Bootstrap(deps, taskruntime.BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 3}})
	if err != nil {
		t.Fatalf("taskruntime.Bootstrap() error = %v", err)
	}
	defer func() { _ = rt.Close() }()
	if _, err := rt.Run(context.Background(), taskruntime.RunRequest{Task: "switch the model to gpt-5.4"}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.requests) == 0 {
		t.Fatal("the run made no model request")
	}
	first := client.requests[0]
	out.InitiallyVisible = hasTool(first, "config_get") || hasTool(first, "config_set")
	out.SearchOffered = hasTool(first, "tool_search")
	if len(client.requests) > 1 {
		for _, msg := range client.requests[1].Messages {
			if msg.ToolCallID == "search" {
				out.FoundGet = foundTool(msg.Content, "config_get")
				out.FoundSet = foundTool(msg.Content, "config_set")
			}
		}
	}
	return out
}

// configSearchingClient searches for "config" once, then ends the run.
type configSearchingClient struct {
	mu       sync.Mutex
	requests []llm.Request
}

func (c *configSearchingClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, req)
	if len(c.requests) == 1 && hasTool(req, "tool_search") {
		return llm.Result{ToolCalls: []llm.ToolCall{{ID: "search", Name: "tool_search", Arguments: map[string]any{"query": "config settings"}}}}, nil
	}
	return llm.Result{Text: `{"type":"final","output":"done"}`}, nil
}
