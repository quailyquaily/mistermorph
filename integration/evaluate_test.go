package integration

import (
	"context"
	"errors"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/llmconfig"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
)

type stubEvaluateClient struct {
	stubIntegrationLLMClient
	model    string
	requests *[]llm.EvaluateRequest
}

func (c *stubEvaluateClient) Evaluate(_ context.Context, req llm.EvaluateRequest) (*llm.EvaluateResult, error) {
	*c.requests = append(*c.requests, req)
	return &llm.EvaluateResult{
		Model:   c.model,
		Answers: map[string]llm.Answer{"move": {Kind: llm.Choice, Selected: "b"}},
	}, nil
}

func newEvaluateTestConfig(t *testing.T) Config {
	t.Helper()
	cfg := DefaultConfig()
	cfg.Features.Skills = false
	cfg.Set("file_state_dir", t.TempDir())
	cfg.Set("llm.provider", "openai")
	cfg.Set("llm.model", "gpt-5.2")
	cfg.Set("llm.profiles", map[string]any{
		"cheap": map[string]any{"model": "gpt-4.1-mini"},
	})
	cfg.Set("llm.routes", map[string]any{
		"decision": map[string]any{"profile": "cheap"},
	})
	return cfg
}

func choiceRequest() llm.EvaluateRequest {
	return llm.EvaluateRequest{
		State: map[string]any{"board": "..."},
		Questions: map[string]llm.Question{
			"move": {Kind: llm.Choice, Instructions: "Pick the best move.", Options: map[string]any{"a": "e4", "b": "d4"}},
		},
	}
}

func TestEvaluateUsesTheDecisionRoute(t *testing.T) {
	var requests []llm.EvaluateRequest
	rt := newRuntime(newEvaluateTestConfig(t), runtimeBuildDependencies{
		buildClient: func(cfg llmconfig.ClientConfig, _ llmutil.RuntimeValues) (llm.Client, error) {
			return &stubEvaluateClient{model: cfg.Model, requests: &requests}, nil
		},
	})

	cases := []struct {
		name      string
		opts      EvaluateOptions
		scene     string
		wantModel string
		wantScene string
	}{
		{name: "route", wantModel: "gpt-4.1-mini", wantScene: "integration.evaluate"},
		{name: "profile override", opts: EvaluateOptions{Profile: "default"}, scene: "inua.board_move", wantModel: "gpt-5.2", wantScene: "inua.board_move"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			requests = nil
			req := choiceRequest()
			req.Scene = tc.scene
			res, err := rt.Evaluate(context.Background(), req, tc.opts)
			if err != nil {
				t.Fatalf("Evaluate() error = %v", err)
			}
			if got := res.Answers["move"].Selected; got != "b" {
				t.Fatalf("selected = %q, want b", got)
			}
			if len(requests) != 1 {
				t.Fatalf("evaluate requests = %d, want 1", len(requests))
			}
			if requests[0].Model != tc.wantModel || requests[0].Scene != tc.wantScene {
				t.Fatalf("request model, scene = %q, %q, want %q, %q", requests[0].Model, requests[0].Scene, tc.wantModel, tc.wantScene)
			}
		})
	}
}

func TestEvaluateReportsUnsupportedForChatOnlyClients(t *testing.T) {
	rt := newRuntime(newEvaluateTestConfig(t), runtimeBuildDependencies{
		buildClient: func(llmconfig.ClientConfig, llmutil.RuntimeValues) (llm.Client, error) {
			return &stubIntegrationLLMClient{}, nil
		},
	})
	if _, err := rt.Evaluate(context.Background(), choiceRequest(), EvaluateOptions{}); !errors.Is(err, llm.ErrEvaluateUnsupported) {
		t.Fatalf("Evaluate() error = %v, want llm.ErrEvaluateUnsupported", err)
	}
}

func TestEvaluateRejectsAnUnknownProfile(t *testing.T) {
	rt := newRuntime(newEvaluateTestConfig(t), runtimeBuildDependencies{
		buildClient: func(llmconfig.ClientConfig, llmutil.RuntimeValues) (llm.Client, error) {
			return &stubIntegrationLLMClient{}, nil
		},
	})
	if _, err := rt.Evaluate(context.Background(), choiceRequest(), EvaluateOptions{Profile: "missing"}); err == nil {
		t.Fatal("Evaluate() with an unknown profile: want an error")
	}
}

type closableEvaluateClient struct{ stubEvaluateClient }

func (*closableEvaluateClient) Close() error { return nil }

func TestEvaluatePassesThroughClosableClients(t *testing.T) {
	var requests []llm.EvaluateRequest
	rt := newRuntime(newEvaluateTestConfig(t), runtimeBuildDependencies{
		buildClient: func(cfg llmconfig.ClientConfig, _ llmutil.RuntimeValues) (llm.Client, error) {
			return &closableEvaluateClient{stubEvaluateClient{model: cfg.Model, requests: &requests}}, nil
		},
	})
	if _, err := rt.Evaluate(context.Background(), choiceRequest(), EvaluateOptions{}); err != nil {
		t.Fatalf("Evaluate() error = %v", err)
	}
}
