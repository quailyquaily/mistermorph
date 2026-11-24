package llmutil

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/llmconfig"
)

func TestOverviewLLM(t *testing.T) {
	tests := []struct {
		name  string
		route ResolvedRoute
		model string
		want  map[string]any
	}{
		{
			name:  "provider and model only",
			route: ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: " openai ", Model: "my-private-model"}},
			want:  map[string]any{"provider": "openai", "model": "my-private-model"},
		},
		{
			name:  "the runtime's own model wins over the route's",
			route: ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "route-model"}},
			model: " bootstrap-model ",
			want:  map[string]any{"provider": "openai", "model": "bootstrap-model"},
		},
		{
			name: "profile, endpoint host, configured window and effort",
			route: ResolvedRoute{
				Profile: "fast",
				Values:  RuntimeValues{ReasoningEffortRaw: " High "},
				ClientConfig: llmconfig.ClientConfig{
					Provider:            "openai",
					Model:               "my-private-model",
					Endpoint:            "https://user:pass@llm.example.com:8443/v1?key=secret",
					APIKey:              "sk-secret",
					ContextWindowTokens: 64000,
					Headers:             map[string]string{"Authorization": "Bearer secret"},
				},
			},
			want: map[string]any{
				"provider":              "openai",
				"model":                 "my-private-model",
				"profile":               "fast",
				"endpoint_host":         "llm.example.com:8443",
				"context_window_tokens": int64(64000),
				"reasoning_effort":      "high",
			},
		},
		{
			name: "an endpoint that is not a URL gives no host",
			route: ResolvedRoute{
				ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "my-private-model", Endpoint: "not a url"},
			},
			want: map[string]any{"provider": "openai", "model": "my-private-model"},
		},
		{
			name: "candidates when there are several, and fallbacks",
			route: ResolvedRoute{
				ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "a-model"},
				Candidates: []ResolvedCandidate{
					{Profile: "a", Weight: 3, ClientConfig: llmconfig.ClientConfig{Model: "a-model"}},
					{Profile: "b", Weight: 1, ClientConfig: llmconfig.ClientConfig{Model: "b-model"}},
				},
				Fallbacks: []ResolvedFallback{
					{Profile: "backup", ClientConfig: llmconfig.ClientConfig{Provider: "anthropic", Model: "c-model", APIKey: "sk-secret"}},
				},
			},
			want: map[string]any{
				"provider": "openai",
				"model":    "a-model",
				"candidates": []map[string]any{
					{"profile": "a", "model": "a-model", "weight": 3},
					{"profile": "b", "model": "b-model", "weight": 1},
				},
				"fallbacks": []map[string]any{
					{"profile": "backup", "provider": "anthropic", "model": "c-model"},
				},
			},
		},
		{
			name: "a single candidate is the route itself, not a spread",
			route: ResolvedRoute{
				ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "a-model"},
				Candidates:   []ResolvedCandidate{{Profile: "a", Weight: 1}},
			},
			want: map[string]any{"provider": "openai", "model": "a-model"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := OverviewLLM(tt.route, tt.model)
			if !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("OverviewLLM() = %#v, want %#v", got, tt.want)
			}
			encoded, err := json.Marshal(got)
			if err != nil {
				t.Fatal(err)
			}
			for _, secret := range []string{"secret", "pass", "Bearer"} {
				if strings.Contains(string(encoded), secret) {
					t.Fatalf("OverviewLLM() leaks %q: %s", secret, encoded)
				}
			}
		})
	}
}

func TestOverviewLLMContextWindowFromCatalog(t *testing.T) {
	got := OverviewLLM(ResolvedRoute{ClientConfig: llmconfig.ClientConfig{Provider: "openai", Model: "gpt-4o"}}, "")
	window, ok := got["context_window_tokens"].(int64)
	if !ok || window <= 0 {
		t.Fatalf("context_window_tokens = %#v, want the catalog's window for gpt-4o", got["context_window_tokens"])
	}
}
