package uniai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	uniaiapi "github.com/quailyquaily/uniai"
	uniaichat "github.com/quailyquaily/uniai/chat"
)

func TestCodexSessionCacheHTTPRequest(t *testing.T) {
	for _, streaming := range []bool{false, true} {
		t.Run(fmt.Sprintf("streaming=%v", streaming), func(t *testing.T) {
			var wantKey string
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				if got, _ := body["prompt_cache_key"].(string); got != wantKey {
					t.Errorf("prompt_cache_key = %q, want %q", got, wantKey)
				}
				for _, header := range []string{"session-id", "x-client-request-id"} {
					if got := r.Header.Get(header); got != wantKey {
						t.Errorf("%s = %q, want %q", header, got, wantKey)
					}
				}
				for _, field := range []string{"prompt_cache_retention", "prompt_cache_options"} {
					if _, exists := body[field]; exists {
						t.Errorf("unexpected Codex field %s", field)
					}
				}
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"sequence_number\":1,\"response\":{\"id\":\"resp_test\",\"object\":\"response\",\"status\":\"completed\",\"output\":[]}}\n\n")
			}))
			defer server.Close()
			client, err := New(Config{Provider: "openai_codex", Model: "gpt-5.5", Endpoint: server.URL, APIKey: "test-key", CacheTTL: "long"})
			if err != nil {
				t.Fatal(err)
			}
			for _, session := range []string{"topic-a", "topic-a", "topic-b", ""} {
				wantKey = session
				req := llm.Request{SessionID: session, Messages: []llm.Message{{Role: "system", Content: "rules"}, {Role: "user", Content: "hello"}}}
				if streaming {
					req.OnStream = func(llm.StreamEvent) error { return nil }
				}
				if _, err := client.Chat(context.Background(), req); err != nil {
					t.Fatal(err)
				}
			}
			if calls != 4 {
				t.Fatalf("requests = %d, want 4", calls)
			}
		})
	}
}

func TestCodexSessionPromptCacheOptions(t *testing.T) {
	for _, tt := range []struct{ name, session, ttl, manual, want string }{
		{"session", "topic-a", "short", "", "topic-a"},
		{"long has no TTL", "topic-a", "long", "", "topic-a"},
		{"off", "topic-a", "off", "", ""},
		{"absent", "", "short", "", ""},
		{"explicit key", "topic-a", "short", "manual-key", "manual-key"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			req := llm.Request{SessionID: tt.session, Messages: []llm.Message{{Role: "system", Content: "system"}}}
			if tt.manual != "" {
				req.Parameters = map[string]any{"openai": map[string]any{"prompt_cache_key": tt.manual}}
			}
			opts := buildChatOptionsForTest(req, "openai_codex", "gpt-5.2-codex", tt.ttl, "", false, uniaiapi.ToolsEmulationOff, nil, "", nil)
			built, err := uniaichat.BuildRequest(opts...)
			if err != nil {
				t.Fatal(err)
			}
			if got := built.Options.OpenAI.GetString("prompt_cache_key"); got != tt.want {
				t.Fatalf("key = %q, want %q", got, tt.want)
			}
			if _, ok := built.Options.OpenAI["prompt_cache_retention"]; ok {
				t.Fatal("Codex TTL must be omitted")
			}
		})
	}
}

func TestCodexSessionPromptCacheKeyLengthAndIsolation(t *testing.T) {
	if got := derivedPromptCacheKey("openai_codex", "model", "test", llm.Request{SessionID: "topic-a"}); got != "test-topic-a" {
		t.Fatalf("prefixed key = %q", got)
	}
	if got := derivedPromptCacheKey("openai_codex", "model", "test", llm.Request{}); got != "" {
		t.Fatalf("key without session = %q", got)
	}
	first := strings.Repeat("a", 64) + "one"
	second := strings.Repeat("a", 64) + "two"
	a := derivedPromptCacheKey("openai_codex", "model", "", llm.Request{SessionID: first})
	b := derivedPromptCacheKey("openai_codex", "model", "", llm.Request{SessionID: second})
	if a == "" || b == "" || len(a) > 64 || len(b) > 64 || a == b {
		t.Fatalf("invalid keys: %q, %q", a, b)
	}
	if again := derivedPromptCacheKey("openai_codex", "model", "", llm.Request{SessionID: first}); again != a {
		t.Fatal("key is not stable")
	}
}
