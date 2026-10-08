package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func spawnToolFor(t *testing.T, e *Engine) tools.Tool {
	t.Helper()
	tool, ok := e.registry.Get(spawnToolName)
	if !ok {
		t.Fatal("spawn tool not registered")
	}
	return tool
}

func TestSpawnToolPassesModelProfile(t *testing.T) {
	reg := tools.NewRegistry()
	if err := reg.Register(stubSubtaskTool{name: "read_file"}); err != nil {
		t.Fatal(err)
	}
	runner := &stubSubtaskRunner{result: &SubtaskResult{Status: SubtaskStatusDone, OutputKind: SubtaskOutputKindText, Output: "ok"}}
	e := New(noopSubtaskClient{}, reg, Config{DefaultModel: "gpt-main"}, DefaultPromptSpec(), WithSubtaskRunner(runner))

	if _, err := spawnToolFor(t, e).Execute(context.Background(), map[string]any{
		"task":          "summarize",
		"tools":         []any{"read_file"},
		"model_profile": " fast ",
	}); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if runner.req.ModelProfile != "fast" {
		t.Fatalf("ModelProfile = %q, want fast", runner.req.ModelProfile)
	}

	if _, err := spawnToolFor(t, e).Execute(context.Background(), map[string]any{
		"task":  "summarize",
		"tools": []any{"read_file"},
	}); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if runner.req.ModelProfile != "" {
		t.Fatalf("ModelProfile = %q, want empty so the parent's configuration is kept", runner.req.ModelProfile)
	}
}

func TestSpawnToolRejectsModelParam(t *testing.T) {
	reg := tools.NewRegistry()
	if err := reg.Register(stubSubtaskTool{name: "read_file"}); err != nil {
		t.Fatal(err)
	}
	runner := &stubSubtaskRunner{}
	e := New(noopSubtaskClient{}, reg, Config{DefaultModel: "gpt-main"}, DefaultPromptSpec(), WithSubtaskRunner(runner))

	_, err := spawnToolFor(t, e).Execute(context.Background(), map[string]any{
		"task":  "summarize",
		"tools": []any{"read_file"},
		"model": "gpt-other",
	})
	if err == nil || !strings.Contains(err.Error(), "model_profile") {
		t.Fatalf("Execute() error = %v, want an error pointing to model_profile", err)
	}
	if runner.called {
		t.Fatal("runner should not run when model is passed")
	}
}

func TestSpawnToolSchemaAndDescription(t *testing.T) {
	tool := newSpawnTool(spawnToolDeps{})
	schema := tool.ParameterSchema()
	if !strings.Contains(schema, `"model_profile"`) {
		t.Fatalf("schema has no model_profile:\n%s", schema)
	}
	if strings.Contains(schema, `"model"`) {
		t.Fatalf("schema still has model:\n%s", schema)
	}
	desc := strings.ToLower(tool.Description())
	if strings.Contains(desc, "parallel") {
		t.Fatalf("description suggests parallel execution: %q", tool.Description())
	}
	if !strings.Contains(desc, "blocks") {
		t.Fatalf("description should say the call blocks: %q", tool.Description())
	}
}

func TestListModelProfilesToolOutput(t *testing.T) {
	lister := func(context.Context) ([]ModelProfile, error) {
		return []ModelProfile{
			{Name: "default", Model: "gpt-main", Description: "Complex analysis.", Current: true},
			{Name: "fast", Model: "claude-fast"},
			{Name: "broken", Error: "llm.profiles.broken.request_timeout: invalid"},
		}, nil
	}
	e := New(noopSubtaskClient{}, tools.NewRegistry(), Config{}, DefaultPromptSpec(), WithModelProfiles(lister))
	tool, ok := e.registry.Get(listModelProfilesToolName)
	if !ok {
		t.Fatal("list_model_profiles not registered")
	}
	if tool.ParameterSchema() == "" {
		t.Fatal("empty parameter schema")
	}
	out, err := tool.Execute(context.Background(), map[string]any{})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	var got struct {
		Profiles []map[string]any `json:"profiles"`
	}
	if err := json.Unmarshal([]byte(out), &got); err != nil {
		t.Fatalf("unmarshal %q: %v", out, err)
	}
	if len(got.Profiles) != 3 {
		t.Fatalf("profiles = %v", got.Profiles)
	}
	if got.Profiles[0]["current"] != true || got.Profiles[0]["description"] != "Complex analysis." {
		t.Fatalf("default entry = %v", got.Profiles[0])
	}
	if _, ok := got.Profiles[1]["current"]; ok {
		t.Fatalf("current should be omitted on other entries: %v", got.Profiles[1])
	}
	if got.Profiles[1]["description"] != "" {
		t.Fatalf("missing description should be an empty string: %v", got.Profiles[1])
	}
	if _, ok := got.Profiles[1]["error"]; ok {
		t.Fatalf("error should be omitted on resolved entries: %v", got.Profiles[1])
	}
	if got.Profiles[2]["error"] == "" || got.Profiles[2]["error"] == nil {
		t.Fatalf("broken entry should carry its error: %v", got.Profiles[2])
	}
	for _, entry := range got.Profiles {
		for key := range entry {
			switch key {
			case "name", "model", "description", "current", "error":
			default:
				t.Fatalf("unexpected field %q in %v", key, entry)
			}
		}
	}
}

func TestListModelProfilesToolReportsListerError(t *testing.T) {
	lister := func(context.Context) ([]ModelProfile, error) { return nil, errors.New("bad routes") }
	e := New(noopSubtaskClient{}, tools.NewRegistry(), Config{}, DefaultPromptSpec(), WithModelProfiles(lister))
	tool, _ := e.registry.Get(listModelProfilesToolName)
	if _, err := tool.Execute(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "bad routes") {
		t.Fatalf("Execute() error = %v, want lister error", err)
	}
}

func TestListModelProfilesNeedsSpawn(t *testing.T) {
	lister := func(context.Context) ([]ModelProfile, error) { return nil, nil }
	cfg := DefaultEngineToolsConfig()
	cfg.SpawnEnabled = false
	e := New(noopSubtaskClient{}, tools.NewRegistry(), Config{}, DefaultPromptSpec(), WithEngineToolsConfig(cfg), WithModelProfiles(lister))
	if _, ok := e.registry.Get(listModelProfilesToolName); ok {
		t.Fatal("list_model_profiles registered without spawn")
	}
	if promptHasBlock(e, subtaskDelegationPromptBlock) || promptHasBlock(e, modelProfilesPromptBlock) {
		t.Fatal("subagent guidance added without spawn")
	}
}

func TestSubtaskPromptGuidance(t *testing.T) {
	plain := New(noopSubtaskClient{}, tools.NewRegistry(), Config{}, DefaultPromptSpec())
	if !promptHasBlock(plain, subtaskDelegationPromptBlock) {
		t.Fatal("delegation guidance missing while spawn is available")
	}
	if promptHasBlock(plain, modelProfilesPromptBlock) {
		t.Fatal("profile guidance added without list_model_profiles")
	}
	if _, ok := plain.registry.Get(listModelProfilesToolName); ok {
		t.Fatal("list_model_profiles registered without a lister")
	}

	lister := func(context.Context) ([]ModelProfile, error) { return nil, nil }
	withProfiles := New(noopSubtaskClient{}, tools.NewRegistry(), Config{}, DefaultPromptSpec(), WithModelProfiles(lister))
	if !promptHasBlock(withProfiles, subtaskDelegationPromptBlock) || !promptHasBlock(withProfiles, modelProfilesPromptBlock) {
		t.Fatal("guidance missing while spawn and list_model_profiles are available")
	}
	lower := strings.ToLower(subtaskDelegationPromptBlock)
	for _, want := range []string{"intermediate content", "evidence", "background"} {
		if !strings.Contains(lower, want) {
			t.Fatalf("delegation guidance does not mention %q", want)
		}
	}
	if !strings.Contains(modelProfilesPromptBlock, "reuse") {
		t.Fatal("profile guidance should allow reusing an earlier result")
	}
}

func promptHasBlock(e *Engine, content string) bool {
	for _, block := range e.spec.Blocks {
		if block.Content == content {
			return true
		}
	}
	return false
}

func TestLocalSubtaskRunnerUsesProfileResolver(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(&mockTool{name: "read_file", result: "content"})
	parentClient := newMockClient()
	subClient := newMockClient(finalResponse("sub done"))
	var resolved string
	closed := false
	e := New(parentClient, reg, Config{MaxSteps: 5, DefaultModel: "gpt-main"}, DefaultPromptSpec(),
		WithSubtaskProfileResolver(func(_ context.Context, profile string) (SubtaskProfile, error) {
			resolved = profile
			return SubtaskProfile{Client: subClient, Model: "claude-fast", Close: func() { closed = true }}, nil
		}),
	)

	out, err := spawnToolFor(t, e).Execute(context.Background(), map[string]any{
		"task":          "read it",
		"tools":         []any{"read_file"},
		"model_profile": "fast",
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	var result SubtaskResult
	if err := json.Unmarshal([]byte(out), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != SubtaskStatusDone {
		t.Fatalf("result = %#v", result)
	}
	if resolved != "fast" || !closed {
		t.Fatalf("resolver profile = %q closed = %v", resolved, closed)
	}
	if len(parentClient.allCalls()) != 0 {
		t.Fatal("parent client used for a subtask with a profile")
	}
	calls := subClient.allCalls()
	if len(calls) == 0 || calls[0].Model != "claude-fast" {
		t.Fatalf("sub client calls = %#v, want model claude-fast", calls)
	}
}

func TestLocalSubtaskRunnerProfileErrors(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(&mockTool{name: "read_file", result: "content"})

	cases := []struct {
		name     string
		resolver SubtaskProfileResolver
		wantErr  string
	}{
		{name: "no resolver", resolver: nil, wantErr: "not supported"},
		{name: "resolver error", resolver: func(context.Context, string) (SubtaskProfile, error) {
			return SubtaskProfile{}, errors.New(`profile "painter" does not have the text ability`)
		}, wantErr: "text ability"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			client := newMockClient(finalResponse("should not run"))
			var opts []Option
			if tc.resolver != nil {
				opts = append(opts, WithSubtaskProfileResolver(tc.resolver))
			}
			e := New(client, reg, Config{MaxSteps: 5, DefaultModel: "gpt-main"}, DefaultPromptSpec(), opts...)
			out, err := spawnToolFor(t, e).Execute(context.Background(), map[string]any{
				"task":          "read it",
				"tools":         []any{"read_file"},
				"model_profile": "painter",
			})
			if err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			var result SubtaskResult
			if err := json.Unmarshal([]byte(out), &result); err != nil {
				t.Fatal(err)
			}
			if result.Status != SubtaskStatusFailed || !strings.Contains(result.Error, tc.wantErr) {
				t.Fatalf("result = %#v, want failure mentioning %q", result, tc.wantErr)
			}
			if !strings.Contains(result.Error, "omit model_profile") {
				t.Fatalf("error should tell the model it can omit model_profile: %q", result.Error)
			}
			if len(client.allCalls()) != 0 {
				t.Fatal("subtask started despite the profile error")
			}
		})
	}
}

func TestLocalSubtaskRunnerWithoutProfileUsesParentClient(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(&mockTool{name: "read_file", result: "content"})
	client := newMockClient(finalResponse("done"))
	resolverCalled := false
	e := New(client, reg, Config{MaxSteps: 5, DefaultModel: "gpt-main"}, DefaultPromptSpec(),
		WithSubtaskProfileResolver(func(context.Context, string) (SubtaskProfile, error) {
			resolverCalled = true
			return SubtaskProfile{}, nil
		}),
	)
	if _, err := spawnToolFor(t, e).Execute(context.Background(), map[string]any{
		"task":  "read it",
		"tools": []any{"read_file"},
	}); err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if resolverCalled {
		t.Fatal("resolver called without model_profile")
	}
	calls := client.allCalls()
	if len(calls) == 0 || calls[0].Model != "gpt-main" {
		t.Fatalf("parent client calls = %#v, want model gpt-main", calls)
	}
}

var _ llm.Client = (*mockClient)(nil)
