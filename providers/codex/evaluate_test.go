package codex

import (
	"context"
	"encoding/json"
	"github.com/quailyquaily/mistermorph/llm"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEvaluateUsesCustomEndpointCredentials(t *testing.T) {
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Authorization") != "Bearer test-key" {
			t.Error("wrong credentials")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if r.URL.Path != "/v1/responses" || body["model"] != "judge" {
			t.Errorf("path=%s body=%v", r.URL.Path, body)
		}
		if _, ok := body["max_output_tokens"]; ok {
			t.Error("unsupported token limit")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":{"message":"stop after capture"}}`))
	}))
	defer server.Close()
	c := New(Config{Endpoint: server.URL, APIKey: "test-key", Model: "judge"})
	_, err := llm.Evaluate(context.Background(), c, llm.EvaluateRequest{State: "Hi", Questions: map[string]llm.Question{"addressed": {Kind: llm.Boolean, Instructions: "Addressed to me?"}}})
	if err == nil || calls != 1 {
		t.Fatalf("calls=%d err=%v", calls, err)
	}
}
