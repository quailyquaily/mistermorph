package uniai

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/llm"
	uniaiapi "github.com/quailyquaily/uniai"
)

func TestHistoryCacheBreakpointsReachHTTP(t *testing.T) {
	for _, tc := range []struct {
		provider, model, cacheTTL, marker string
		markerCount                       int
	}{
		{"openai", "gpt-5.6", "short", "prompt_cache_breakpoint", 2},
		{"openai_resp", "gpt-5.6-sol", "short", "prompt_cache_breakpoint", 2},
		{"anthropic", "claude-sonnet-4-6", "short", "cache_control", 2},
		{"openai", "gpt-5.5", "short", "", 0},
		{"openai_resp", "gpt-5.5", "short", "", 0},
		{"openai", "gpt-5.6", "off", "", 0},
		{"openai_resp", "gpt-5.6-sol", "off", "", 0},
	} {
		t.Run(tc.provider+"/"+tc.model+"/"+tc.cacheTTL, func(t *testing.T) {
			requests := make(chan string, 4)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				raw, _ := io.ReadAll(r.Body)
				requests <- string(raw)
				// Only inspect the outbound request; no model is needed.
				w.WriteHeader(http.StatusBadRequest)
				_, _ = io.WriteString(w, `{"error":{"message":"request captured","type":"invalid_request_error"}}`)
			}))
			defer server.Close()
			client := &Client{provider: tc.provider, model: tc.model, cacheTTL: tc.cacheTTL, client: uniaiapi.New(uniaiapi.Config{
				Provider: tc.provider, OpenAIAPIBase: server.URL, OpenAIAPIKey: "test", AnthropicAPIBase: server.URL, AnthropicAPIKey: "test",
			})}
			marked := func(role, text string) llm.Message {
				return llm.Message{Role: role, Content: text, Parts: []llm.Part{{Type: llm.PartTypeText, Text: text, CacheControl: &llm.CacheControl{TTL: "short"}}}}
			}
			for _, role := range []string{"user", "assistant"} {
				ctx, cancel := context.WithTimeout(t.Context(), 3*time.Second)
				_, chatErr := client.Chat(ctx, llm.Request{Model: tc.model, Messages: []llm.Message{
					marked("system", "stable-system"), {Role: "user", Content: "earlier-history"}, marked(role, "last-history"),
					{Role: "user", Content: "runtime-meta"}, {Role: "user", Content: "current-input"},
				}})
				cancel()
				var raw string
				select {
				case raw = <-requests:
				default:
					t.Fatalf("provider did not send request: %v", chatErr)
				}
				if tc.marker != "" && strings.Count(raw, `"`+tc.marker+`"`) != tc.markerCount {
					t.Fatalf("wrong cache markers: %s", raw)
				}
				if tc.marker == "" && (strings.Contains(raw, "cache_control") || strings.Contains(raw, "prompt_cache_breakpoint")) {
					t.Fatalf("unsupported marker: %s", raw)
				}
				for _, text := range []string{"stable-system", "earlier-history", "last-history", "runtime-meta", "current-input"} {
					if strings.Count(raw, text) != 1 {
						t.Fatalf("text duplicated or lost (%s): %s", text, raw)
					}
				}
				var payload map[string]json.RawMessage
				if err := json.Unmarshal([]byte(raw), &payload); err != nil {
					t.Fatal(err)
				}
				field := "messages"
				want := 5
				if tc.provider == "openai_resp" {
					field = "input"
				}
				if tc.provider == "anthropic" {
					want = 4
				}
				var messages []json.RawMessage
				if err := json.Unmarshal(payload[field], &messages); err != nil || len(messages) != want {
					t.Fatalf("message boundaries lost: %s (%v)", raw, err)
				}
				if tc.marker != "" {
					for _, message := range messages {
						text := string(message)
						wantMarker := strings.Contains(text, "stable-system") || strings.Contains(text, "last-history")
						if strings.Contains(text, `"`+tc.marker+`"`) != wantMarker {
							t.Fatalf("cache marker on wrong message: %s", text)
						}
					}
				}
			}
		})
	}
}
