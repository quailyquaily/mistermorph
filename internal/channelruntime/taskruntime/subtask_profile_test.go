package taskruntime

import (
	"context"
	"encoding/json"
	"log/slog"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/channelruntime/depsutil"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func subtaskProfileTestValues() llmutil.RuntimeValues {
	return llmutil.RuntimeValues{
		Provider:           "openai",
		APIKey:             "sk-main",
		Model:              "gpt-main",
		ReasoningEffortRaw: "high",
		Description:        "Complex analysis.",
		Profiles: map[string]llmutil.ProfileConfig{
			"fast": {
				Provider:           "anthropic",
				APIKey:             "sk-fast",
				Model:              "claude-fast",
				ReasoningEffortRaw: "low",
				Description:        "Short summaries.",
			},
			"painter": {Provider: "openai", APIKey: "sk-image", Model: "gpt-image", Abilities: []string{"image"}},
			"judge":   {Provider: "typesafe", APIKey: "sk-judge", Model: "judge-1"},
		},
	}
}

func subtaskProfileTestDeps(t *testing.T, values *llmutil.RuntimeValues, clients func(route llmutil.ResolvedRoute) llm.Client, created *[]llmutil.ResolvedRoute) depsutil.CommonDependencies {
	t.Helper()
	deps := depsutil.CommonDependencies{
		Logger:     func() (*slog.Logger, error) { return slog.Default(), nil },
		LogOptions: func() agent.LogOptions { return agent.LogOptions{} },
		ResolveLLMRoute: func(purpose string) (llmutil.ResolvedRoute, error) {
			return llmutil.ResolveRoute(*values, purpose)
		},
		CreateLLMClient: func(route llmutil.ResolvedRoute) (llm.Client, error) {
			*created = append(*created, route)
			return clients(route), nil
		},
		Registry: func() *tools.Registry {
			reg := tools.NewRegistry()
			if err := reg.Register(stubAllowedSubtaskTool{name: "allowed_tool"}); err != nil {
				t.Fatalf("Register(allowed_tool) error = %v", err)
			}
			return reg
		},
		PromptSpec: func(context.Context, *slog.Logger, agent.LogOptions, string, llm.Client, string, []string) (agent.PromptSpec, []string, error) {
			return agent.DefaultPromptSpec(), nil, nil
		},
	}
	if values != nil {
		deps.LLMValues = func() (llmutil.RuntimeValues, error) { return *values, nil }
	}
	return deps
}

func lastToolMessage(req llm.Request) string {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "tool" {
			return req.Messages[i].Content
		}
	}
	return ""
}

func TestPreparedEngineSpawnSelectsModelProfile(t *testing.T) {
	values := subtaskProfileTestValues()
	parentClient := &subtaskRouteSnapshotParentClient{requestedTool: "allowed_tool", spawnProfile: "fast"}
	childClient := &stubTaskRuntimeClient{result: llm.Result{Text: `{"type":"final","output":"child done"}`}}
	var created []llmutil.ResolvedRoute
	deps := subtaskProfileTestDeps(t, &values, func(route llmutil.ResolvedRoute) llm.Client {
		if route.Profile == "fast" {
			return childClient
		}
		return parentClient
	}, &created)
	rt, err := NewRunPreparer(deps, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 3, ToolRepeatLimit: 2}})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	defer func() { _ = rt.Close() }()

	result, err := rt.Run(context.Background(), RunRequest{Task: "run parent task", DisableRuntimeTools: true})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if result.Final == nil || result.Final.Output != "parent done" {
		t.Fatalf("final = %#v", result.Final)
	}
	if len(created) != 2 {
		t.Fatalf("created routes = %d, want parent and child", len(created))
	}
	parent, child := created[0], created[1]
	if parent.Profile != "default" || parent.ClientConfig.Model != "gpt-main" {
		t.Fatalf("parent route = %q/%q", parent.Profile, parent.ClientConfig.Model)
	}
	if child.Profile != "fast" || child.ClientConfig.Provider != "anthropic" || child.ClientConfig.Model != "claude-fast" {
		t.Fatalf("child route = %q/%q/%q, want fast/anthropic/claude-fast", child.Profile, child.ClientConfig.Provider, child.ClientConfig.Model)
	}
	if child.Values.ReasoningEffortRaw != "low" {
		t.Fatalf("child reasoning effort = %q, want the profile's low", child.Values.ReasoningEffortRaw)
	}
	if len(childClient.requests) != 1 || childClient.requests[0].Model != "claude-fast" {
		t.Fatalf("child requests = %#v, want one request for claude-fast", childClient.requests)
	}
	if got := parentClient.requests[1].Model; got != "gpt-main" {
		t.Fatalf("parent model after the subtask = %q, want gpt-main", got)
	}
}

func TestPreparedEngineSpawnRejectsUnusableProfiles(t *testing.T) {
	cases := []struct {
		name    string
		profile string
		values  bool
		wantErr string
	}{
		{name: "unknown", profile: "missing", values: true, wantErr: `missing profile \"missing\"`},
		{name: "image only", profile: "painter", values: true, wantErr: "text ability"},
		{name: "typesafe", profile: "judge", values: true, wantErr: "typesafe"},
		{name: "no profile resolver", profile: "fast", values: false, wantErr: "not supported"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			values := subtaskProfileTestValues()
			parentClient := &subtaskRouteSnapshotParentClient{requestedTool: "allowed_tool", spawnProfile: tc.profile}
			var created []llmutil.ResolvedRoute
			valuesPtr := &values
			deps := subtaskProfileTestDeps(t, valuesPtr, func(llmutil.ResolvedRoute) llm.Client { return parentClient }, &created)
			if !tc.values {
				deps.LLMValues = nil
			}
			rt, err := NewRunPreparer(deps, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 3, ToolRepeatLimit: 2}})
			if err != nil {
				t.Fatalf("NewRunPreparer() error = %v", err)
			}
			defer func() { _ = rt.Close() }()

			if _, err := rt.Run(context.Background(), RunRequest{Task: "run parent task", DisableRuntimeTools: true}); err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			if len(created) != 1 {
				t.Fatalf("created routes = %d, want only the parent (no subtask started)", len(created))
			}
			observation := lastToolMessage(parentClient.requests[1])
			if !strings.Contains(observation, `"status":"failed"`) || !strings.Contains(observation, tc.wantErr) || !strings.Contains(observation, "omit model_profile") {
				t.Fatalf("spawn observation = %s, want a failure mentioning %q", observation, tc.wantErr)
			}
		})
	}
}

type listProfilesParentClient struct {
	requests []llm.Request
}

func (c *listProfilesParentClient) Chat(_ context.Context, req llm.Request) (llm.Result, error) {
	c.requests = append(c.requests, req)
	if len(c.requests) > 1 {
		return llm.Result{Text: `{"type":"final","output":"parent done"}`}, nil
	}
	for _, tool := range req.Tools {
		if tool.Name == "list_model_profiles" {
			return llm.Result{ToolCalls: []llm.ToolCall{{ID: "call_list", Name: "list_model_profiles", Arguments: map[string]any{}}}}, nil
		}
	}
	return llm.Result{Text: `{"type":"final","output":"parent done"}`}, nil
}

func TestPreparedEngineRegistersListModelProfiles(t *testing.T) {
	values := subtaskProfileTestValues()
	values.Profiles["broken"] = llmutil.ProfileConfig{Provider: "openai", Model: "gpt-broken", RequestTimeoutRaw: "ten"}
	parentClient := &listProfilesParentClient{}
	var created []llmutil.ResolvedRoute
	deps := subtaskProfileTestDeps(t, &values, func(llmutil.ResolvedRoute) llm.Client { return parentClient }, &created)
	rt, err := NewRunPreparer(deps, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 3, ToolRepeatLimit: 2}})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	defer func() { _ = rt.Close() }()

	if _, err := rt.Run(context.Background(), RunRequest{Task: "run parent task", DisableRuntimeTools: true}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if len(parentClient.requests) != 2 {
		t.Fatalf("parent requests = %d, want the list call and the final", len(parentClient.requests))
	}
	var got struct {
		Profiles []struct {
			Name        string `json:"name"`
			Model       string `json:"model"`
			Description string `json:"description"`
			Current     bool   `json:"current"`
			Error       string `json:"error"`
		} `json:"profiles"`
	}
	observation := lastToolMessage(parentClient.requests[1])
	if err := json.Unmarshal([]byte(observation), &got); err != nil {
		t.Fatalf("unmarshal %q: %v", observation, err)
	}
	var names []string
	for _, profile := range got.Profiles {
		names = append(names, profile.Name)
	}
	if strings.Join(names, ",") != "default,broken,fast" {
		t.Fatalf("profiles = %v, want default,broken,fast", names)
	}
	if !got.Profiles[0].Current || got.Profiles[0].Model != "gpt-main" || got.Profiles[0].Description != "Complex analysis." {
		t.Fatalf("default entry = %#v", got.Profiles[0])
	}
	if got.Profiles[1].Error == "" || got.Profiles[2].Current || got.Profiles[2].Model != "claude-fast" {
		t.Fatalf("entries = %#v", got.Profiles)
	}
}

func TestPreparedEngineOmitsListModelProfilesWithOneCandidate(t *testing.T) {
	values := subtaskProfileTestValues()
	delete(values.Profiles, "fast")
	parentClient := &listProfilesParentClient{}
	var created []llmutil.ResolvedRoute
	deps := subtaskProfileTestDeps(t, &values, func(llmutil.ResolvedRoute) llm.Client { return parentClient }, &created)
	rt, err := NewRunPreparer(deps, BootstrapOptions{AgentConfig: agent.Config{MaxSteps: 3, ToolRepeatLimit: 2}})
	if err != nil {
		t.Fatalf("NewRunPreparer() error = %v", err)
	}
	defer func() { _ = rt.Close() }()

	if _, err := rt.Run(context.Background(), RunRequest{Task: "run parent task", DisableRuntimeTools: true}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	for _, tool := range parentClient.requests[0].Tools {
		if tool.Name == "list_model_profiles" {
			t.Fatal("list_model_profiles registered with only one candidate (painter and judge cannot run subtasks)")
		}
	}
	hasSpawn := false
	for _, tool := range parentClient.requests[0].Tools {
		hasSpawn = hasSpawn || tool.Name == "spawn"
	}
	if !hasSpawn {
		t.Fatal("spawn missing; the test would not show anything")
	}
}

func TestSubtaskProfileResolver(t *testing.T) {
	values := subtaskProfileTestValues()
	fast := values.Profiles["fast"]
	fast.CacheTTL = "long"
	values.Profiles["fast"] = fast
	client := &lifecycleTaskRuntimeClient{}
	var created []llmutil.ResolvedRoute
	deps := subtaskProfileTestDeps(t, &values, func(llmutil.ResolvedRoute) llm.Client { return client }, &created)

	resolve := SubtaskProfileResolver(deps)
	if resolve == nil {
		t.Fatal("SubtaskProfileResolver() = nil")
	}
	target, err := resolve(context.Background(), "fast")
	if err != nil {
		t.Fatalf("resolve(fast) error = %v", err)
	}
	if target.Model != "claude-fast" || target.Client != client || target.SystemPromptCacheControl == nil {
		t.Fatalf("target = %#v", target)
	}
	if len(created) != 1 || created[0].Profile != "fast" {
		t.Fatalf("created routes = %#v", created)
	}
	target.Close()
	if client.closeCalls != 1 {
		t.Fatalf("close calls = %d, want 1", client.closeCalls)
	}

	if _, err := resolve(context.Background(), "painter"); err == nil || !strings.Contains(err.Error(), "text ability") {
		t.Fatalf("resolve(painter) error = %v", err)
	}
	if len(created) != 1 {
		t.Fatal("client created for a profile that cannot run a subtask")
	}

	deps.LLMValues = nil
	if SubtaskProfileResolver(deps) != nil {
		t.Fatal("resolver without LLMValues should be nil")
	}
	if ModelProfileLister(deps, "default") != nil {
		t.Fatal("lister without LLMValues should be nil")
	}
}
