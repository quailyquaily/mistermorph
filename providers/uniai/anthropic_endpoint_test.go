package uniai

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	uniaiapi "github.com/quailyquaily/uniai"
)

func TestAnthropicGatewayEndpointAndAuthentication(t *testing.T) {
	for _, tc := range []struct{ endpointPath, wantBasePath string }{
		{"", "/v1"},
		{"/v1/", "/v1"},
		{"/gateway/anthropic", "/gateway/anthropic/v1"},
		{"/gateway/anthropic/v1", "/gateway/anthropic/v1"},
	} {
		t.Run(tc.endpointPath, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.Method != http.MethodPost || r.URL.Path != tc.wantBasePath+"/messages" {
					t.Errorf("request = %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("x-api-key") != "gateway-test-key" || r.Header.Get("Authorization") != "" {
					t.Error("expected x-api-key authentication without a bearer header")
				}
				if r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("X-Gateway-Test") != "forwarded" {
					t.Error("missing version or custom header")
				}
				var body struct {
					Model  string `json:"model"`
					Stream bool   `json:"stream"`
				}
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Model != "deployment-alias" || !body.Stream {
					t.Errorf("body = %+v, error = %v", body, err)
				}
				w.Header().Set("Content-Type", "text/event-stream")
				for _, chunk := range []string{
					`{"type":"message_start","message":{"id":"test","model":"deployment-alias","usage":{"input_tokens":1}}}`,
					`{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
					`{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}`,
					`{"type":"content_block_stop","index":0}`,
					`{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}`,
					`{"type":"message_stop"}`,
				} {
					fmt.Fprintf(w, "data: %s\n\n", chunk)
				}
			}))
			defer server.Close()
			client, err := New(Config{
				Provider: "anthropic", Endpoint: server.URL + tc.endpointPath,
				APIKey: " gateway-test-key ", Model: "deployment-alias",
				Headers: map[string]string{"X-Gateway-Test": "forwarded"},
			})
			if err != nil {
				t.Fatal(err)
			}
			// Assert before Chat so a broken mapping never sends even the fake key off-host.
			if got := client.client.GetConfig().APIBase; got != server.URL+tc.wantBasePath {
				t.Fatalf("APIBase = %q, want configured gateway %q", got, server.URL+tc.wantBasePath)
			}
			result, err := client.Chat(context.Background(), llm.Request{
				Messages: []llm.Message{{Role: "user", Content: "hello"}},
				OnStream: func(llm.StreamEvent) error { return nil },
			})
			if err != nil || result.Text != "hello" || calls != 1 {
				t.Fatalf("Chat = %q, %v; calls = %d", result.Text, err, calls)
			}
		})
	}
}

func TestAnthropicEmptyEndpointKeepsOfficialDefault(t *testing.T) {
	client, err := New(Config{Provider: "anthropic", APIKey: "test-key"})
	if err != nil {
		t.Fatal(err)
	}
	if got := client.client.GetConfig().APIBase; got != uniaiapi.DefaultAnthropicAPIBase {
		t.Fatalf("APIBase = %q, want %q", got, uniaiapi.DefaultAnthropicAPIBase)
	}
}
