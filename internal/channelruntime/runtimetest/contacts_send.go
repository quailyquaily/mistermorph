// Package runtimetest checks, from a runtime's own tests, how that runtime's real dependencies
// prepare an ordinary run.
package runtimetest

import (
	"context"
	"encoding/json"
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

// ContactsSendDiscovery is what the model saw in one ordinary run that searched for "contacts send".
type ContactsSendDiscovery struct {
	// InitiallyVisible: contacts_send was in the first request.
	InitiallyVisible bool
	// SearchOffered: tool_search was in the first request.
	SearchOffered bool
	// Found: tool_search returned contacts_send.
	Found bool
	// VisibleAfterSearch: contacts_send was in the request after the search.
	VisibleAfterSearch bool
}

// DiscoverContactsSend runs one ordinary task through deps, as the runtime that built them runs a
// message: its registry, triggered static tools and tool search settings. Only the model and the
// prompt are replaced: the model calls tool_search with "contacts send" and then ends. Nothing is
// sent.
func DiscoverContactsSend(t testing.TB, deps depsutil.CommonDependencies) ContactsSendDiscovery {
	t.Helper()
	client := &searchingClient{}
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
	if _, err := rt.Run(context.Background(), taskruntime.RunRequest{Task: "let Ann know the build is green"}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	client.mu.Lock()
	defer client.mu.Unlock()
	if len(client.requests) == 0 {
		t.Fatal("the run made no model request")
	}
	out := ContactsSendDiscovery{
		InitiallyVisible: hasTool(client.requests[0], "contacts_send"),
		SearchOffered:    hasTool(client.requests[0], "tool_search"),
	}
	if len(client.requests) > 1 {
		out.VisibleAfterSearch = hasTool(client.requests[1], "contacts_send")
		for _, msg := range client.requests[1].Messages {
			if msg.ToolCallID == "search" {
				out.Found = foundTool(msg.Content, "contacts_send")
			}
		}
	}
	return out
}

// searchingClient searches for "contacts send" once, then ends the run.
type searchingClient struct {
	mu       sync.Mutex
	requests []llm.Request
}

func (c *searchingClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.requests = append(c.requests, req)
	if len(c.requests) == 1 && hasTool(req, "tool_search") {
		return llm.Result{ToolCalls: []llm.ToolCall{{ID: "search", Name: "tool_search", Arguments: map[string]any{"query": "contacts send"}}}}, nil
	}
	return llm.Result{Text: `{"type":"final","output":"done"}`}, nil
}

func hasTool(req llm.Request, name string) bool {
	for _, tool := range req.Tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}

func foundTool(result, name string) bool {
	var out struct {
		Tools []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if json.Unmarshal([]byte(result), &out) != nil {
		return false
	}
	for _, tool := range out.Tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}
