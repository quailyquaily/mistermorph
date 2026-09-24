package uniai

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/quailyquaily/mistermorph/llm"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEvaluateNativeAndEmulated(t *testing.T) {
	for _, provider := range []string{"openai", "typesafe"} {
		for _, invalid := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/invalid=%v", provider, invalid), func(t *testing.T) {
				calls := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					if r.Header.Get("Authorization") != "Bearer test-key" {
						t.Error("missing credentials")
					}
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
					}
					if body["model"] != "test-model" {
						t.Errorf("model=%v", body["model"])
					}
					w.Header().Set("Content-Type", "application/json")
					if provider == "typesafe" {
						if r.URL.Path != "/v1/systemone" {
							t.Error(r.URL.Path)
						}
						answers := `{"addressed":{"type":"noul","noul":0.9}}`
						if invalid {
							answers = `{}`
						}
						fmt.Fprintf(w, `{"model":"test-model","answers":%s,"usage":{"input_tokens":10,"output_tokens":0}}`, answers)
					} else {
						if r.URL.Path != "/v1/chat/completions" {
							t.Error(r.URL.Path)
						}
						content := `{"addressed":true}`
						if invalid {
							content = `{}`
						}
						json.NewEncoder(w).Encode(map[string]any{"model": "test-model", "choices": []any{map[string]any{"index": 0, "finish_reason": "stop", "message": map[string]any{"role": "assistant", "content": content}}}, "usage": map[string]any{"prompt_tokens": 10, "completion_tokens": 0, "total_tokens": 10}})
					}
				}))
				defer server.Close()
				client, err := New(Config{Provider: provider, Endpoint: server.URL + "/v1", APIKey: "test-key", Model: "test-model"})
				if err != nil {
					t.Fatal(err)
				}
				result, err := client.Evaluate(context.Background(), llm.EvaluateRequest{State: map[string]any{"message": "Hi"}, Questions: map[string]llm.Question{"addressed": {Kind: llm.Boolean, Instructions: "Is this addressed to the bot?"}}})
				if (err != nil) != invalid {
					t.Fatalf("err=%v", err)
				}
				if result == nil || result.Usage == nil || result.Usage.InputTokens == nil || *result.Usage.InputTokens != 10 {
					t.Fatalf("lost usage: %+v", result)
				}
				if calls != 1 {
					t.Fatalf("calls=%d", calls)
				}
				if result.Emulated != (provider == "openai") {
					t.Fatal("wrong path")
				}
				if invalid {
					if result.Answers != nil {
						t.Fatal("answers on failure")
					}
					return
				}
				a := result.Answers["addressed"]
				if provider == "openai" && (a.BooleanValue == nil || !*a.BooleanValue) {
					t.Fatal(a)
				}
				if provider == "typesafe" && (a.ProbabilityTrue == nil || *a.ProbabilityTrue != 0.9) {
					t.Fatal(a)
				}
			})
		}
	}
}
