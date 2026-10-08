package llmutil

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/configdefaults"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/spf13/viper"
)

func TestLLMRequestUserAgent(t *testing.T) {
	for _, provider := range []string{"openai", "openai_resp", "anthropic", "gemini", "openai_codex"} {
		for _, tt := range []struct {
			name    string
			global  string
			named   bool
			headers map[string]string
			want    string
		}{
			{name: "default configuration", want: "mistermorph/1.0 (+https://github.com/quailyquaily)"},
			{name: "global override", global: "custom-global/1.0", want: "custom-global/1.0"},
			{name: "explicit override", headers: map[string]string{"User-Agent": "explicit/1.0"}, want: "explicit/1.0"},
			{name: "case insensitive override", headers: map[string]string{"uSeR-aGeNt": "mixed/1.0"}, want: "mixed/1.0"},
			{name: "explicit empty", headers: map[string]string{"User-Agent": ""}, want: ""},
			{name: "named default", named: true, want: "mistermorph/1.0 (+https://github.com/quailyquaily)"},
			{name: "named global override", named: true, global: "custom-global/1.0", want: "custom-global/1.0"},
			{name: "named explicit override", named: true, headers: map[string]string{"user-agent": "profile/1.0"}, want: "profile/1.0"},
		} {
			t.Run(provider+"/"+tt.name, func(t *testing.T) {
				requests := make(chan http.Header, 1)
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					select {
					case requests <- r.Header.Clone():
					default:
					}
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusBadRequest)
					_, _ = w.Write([]byte(`{"error":{"message":"test response","type":"invalid_request_error"}}`))
				}))
				defer server.Close()

				v := viper.New()
				configdefaults.Apply(v)
				if tt.global != "" {
					v.Set("user_agent", tt.global)
				}
				v.Set("llm.provider", provider)
				v.Set("llm.endpoint", server.URL)
				v.Set("llm.api_key", "test-key")
				v.Set("llm.model", "test-model")
				headers := cloneStringMap(tt.headers)
				if headers != nil {
					headers["X-Test-Header"] = "preserved"
				}
				profile := RouteProfileDefault
				if tt.named {
					profile = "child"
					v.Set("llm.headers", map[string]string{"User-Agent": "parent-only/1.0", "X-Parent-Only": "private"})
					v.Set("llm.profiles", map[string]any{"child": map[string]any{
						"provider": provider, "endpoint": server.URL, "api_key": "test-key", "model": "test-model", "headers": headers,
					}})
				} else {
					v.Set("llm.headers", headers)
				}
				resolved, err := ResolveProfile(requireRuntimeValues(t, v), profile)
				if err != nil {
					t.Fatal(err)
				}
				// Providers with a fixed API base must also use the local test server.
				resolved.ClientConfig.Endpoint = server.URL
				originalHeaders := cloneStringMap(resolved.ClientConfig.Headers)
				client, err := ClientFromConfigWithValues(resolved.ClientConfig, resolved.Values)
				if err != nil {
					t.Fatal(err)
				}
				defer closeDistinctClients(client)
				_, chatErr := client.Chat(context.Background(), llm.Request{
					Model: "test-model", Messages: []llm.Message{{Role: "system", Content: "Answer briefly."}, {Role: "user", Content: "hello"}},
				})
				select {
				case got := <-requests:
					if ua := got.Get("User-Agent"); ua != tt.want {
						t.Errorf("User-Agent = %q, want %q", ua, tt.want)
					}
					if got.Get("X-Test-Header") != headers["X-Test-Header"] || got.Get("X-Parent-Only") != "" {
						t.Errorf("unexpected custom headers: %v", got)
					}
				default:
					t.Fatalf("LLM client did not send a request: %v", chatErr)
				}
				if !reflect.DeepEqual(resolved.ClientConfig.Headers, originalHeaders) {
					t.Fatal("client construction mutated the profile headers")
				}
			})
		}
	}
}
