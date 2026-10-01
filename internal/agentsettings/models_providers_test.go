package agentsettings

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/testhttp"
	"github.com/spf13/viper"
)

func TestHandlerModelsNativeProviders(t *testing.T) {
	for _, tc := range []struct{ name, request, path, authHeader, body, want string }{
		{"anthropic", `{"inference_provider":"anthropic","api_key":"key"}`, "/v1/models", "x-api-key", `{"data":[{"id":"claude-test","created_at":"2026-01-01T00:00:00Z"}],"has_more":false}`, `"created":1767225600`},
		{"anthropic compatible", `{"inference_provider":"anthropic_compatible","endpoint":"https://proxy.example/claude/v1","api_key":"key"}`, "/claude/v1/models", "x-api-key", `{"data":[{"id":"claude-test"}],"has_more":false}`, `"items":["claude-test"]`},
		{"gemini", `{"inference_provider":"gemini","api_key":"key"}`, "/v1beta/models", "x-goog-api-key", `{"models":[{"name":"models/gemini-test"}]}`, `"items":["gemini-test"]`},
		{"cloudflare", `{"inference_provider":"cloudflare","api_key":"key","cloudflare_account_id":"account-test"}`, "/client/v4/accounts/account-test/ai/models/search", "Authorization", `{"success":true,"result":[{"id":"internal","name":"@cf/test"}],"result_info":{"total_pages":1}}`, `"items":["@cf/test"]`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			testhttp.WithDefaultTransport(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tc.path {
					t.Errorf("path = %s, want %s", r.URL.Path, tc.path)
				}
				wantAuth := "key"
				if tc.authHeader == "Authorization" {
					wantAuth = "Bearer key"
				}
				if r.Header.Get(tc.authHeader) != wantAuth {
					t.Errorf("missing provider auth header %s", tc.authHeader)
				}
				if tc.authHeader == "x-api-key" && r.Header.Get("anthropic-version") != "2023-06-01" {
					t.Error("missing Anthropic version")
				}
				_, _ = io.WriteString(w, tc.body)
			}))
			reader := viper.New()
			handler := NewHandler(HandlerOptions{Owner: &handlerTestOwner{reader: NewReaderSnapshot(reader)}})
			rec := httptest.NewRecorder()
			handler.Models(rec, httptest.NewRequest(http.MethodPost, "/settings/agent/models", strings.NewReader(tc.request)))
			if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), tc.want) {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestHandlerModelsCloudflareSavedAccount(t *testing.T) {
	reader := viper.New()
	reader.Set("llm.inference_provider", "cloudflare")
	reader.Set("llm.api_key", "key")
	reader.Set("llm.cloudflare.account_id", "saved-default")
	reader.Set("llm.profiles.named.inference_provider", "cloudflare")
	reader.Set("llm.profiles.named.api_key", "key")
	reader.Set("llm.profiles.named.cloudflare.account_id", "saved-profile")
	for _, tc := range []struct{ body, want string }{
		{`{"inference_provider":"cloudflare"}`, "saved-default"},
		{`{"target_profile":"named","inference_provider":"cloudflare"}`, "saved-profile"},
		{`{"target_profile":"named","inference_provider":"cloudflare","cloudflare_account_id":"new-account"}`, "new-account"},
	} {
		t.Run(tc.want, func(t *testing.T) {
			testhttp.WithDefaultTransport(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strings.Contains(r.URL.Path, "/accounts/"+tc.want+"/") {
					t.Errorf("wrong account path: %s", r.URL.Path)
				}
				_, _ = io.WriteString(w, `{"success":true,"result":[]}`)
			}))
			handler := NewHandler(HandlerOptions{Owner: &handlerTestOwner{reader: NewReaderSnapshot(reader)}})
			rec := httptest.NewRecorder()
			handler.Models(rec, httptest.NewRequest(http.MethodPost, "/settings/agent/models", strings.NewReader(tc.body)))
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestHandlerModelsCloudflareRequiresAccount(t *testing.T) {
	handler := NewHandler(HandlerOptions{
		Owner: &handlerTestOwner{reader: NewReaderSnapshot(viper.New())},
		FetchModels: func(context.Context, ModelLookupConfig) ([]ModelInfo, error) {
			t.Fatal("must reject missing account before fetching")
			return nil, nil
		},
	})
	rec := httptest.NewRecorder()
	handler.Models(rec, httptest.NewRequest(http.MethodPost, "/settings/agent/models", strings.NewReader(`{"inference_provider":"cloudflare","api_key":"key"}`)))
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "account") {
		t.Fatalf("status = %d, body = %s", rec.Code, rec.Body.String())
	}
}
