package agentsettings

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/testhttp"
)

func TestFetchModelsListsNewestFirst(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/models" || r.Header.Get("Authorization") != "Bearer key" {
			t.Errorf("request = %s auth=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		_, _ = io.WriteString(w, `{"data":[
			{"id":"gpt-3.5-turbo","created":1677610602},
			{"id":"gpt-5","created":1754000000},
			{"id":"local-a"},
			{"id":"gpt-5","created":1754000000},
			{"id":"in-ms","created":1760000000000},
			{"id":"as-string","created":"1700000000"},
			{"id":"aaa-local"}
		]}`)
	}))
	defer server.Close()
	models, err := FetchModels(context.Background(), ModelLookupConfig{Provider: "openai", Endpoint: server.URL + "/v1", APIKey: "key"})
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, model := range models {
		ids = append(ids, model.ID)
	}
	want := []string{"in-ms", "gpt-5", "as-string", "gpt-3.5-turbo", "aaa-local", "local-a"}
	if len(ids) != len(want) {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("ids = %v, want %v", ids, want)
		}
	}
	if models[0].Created != 1760000000 {
		t.Fatalf("milliseconds not converted: %d", models[0].Created)
	}
}

func TestFetchModelsEndpoints(t *testing.T) {
	for _, suffix := range []string{"", "/v1/", "/v1/models", "/proxy/v1/models"} {
		t.Run(suffix, func(t *testing.T) {
			base := testhttp.WithDefaultTransport(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				wantPath := "/v1/models"
				if suffix == "/proxy/v1/models" {
					wantPath = suffix
				}
				if r.Method != http.MethodGet || r.URL.Path != wantPath || r.Header.Get("Authorization") != "Bearer key" {
					t.Errorf("unexpected models request: %s %s", r.Method, r.URL.Path)
				}
				_, _ = io.WriteString(w, `{"data":[]}`)
			}))
			models, err := FetchModels(t.Context(), ModelLookupConfig{Provider: "openai", Endpoint: base + suffix, APIKey: " key "})
			if err != nil || models == nil || len(models) != 0 {
				t.Fatalf("models = %#v, error = %v", models, err)
			}
		})
	}
}

func TestFetchModelsRejectsInvalidCatalog(t *testing.T) {
	for _, body := range []string{
		`{"error":{"message":"catalog unavailable"}}`,
		`{"object":"list"}`,
		`{"data":[{"id":"valid"},{}]}`,
		`not json`,
	} {
		t.Run(body, func(t *testing.T) {
			base := testhttp.WithDefaultTransport(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.WriteString(w, body)
			}))
			models, err := FetchModels(t.Context(), ModelLookupConfig{Provider: "openai", Endpoint: base, APIKey: "key"})
			if err == nil || models != nil {
				t.Fatalf("models = %#v, error = %v; want failure without partial catalog", models, err)
			}
		})
	}
}

func TestFetchModelsCanceled(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := FetchModels(ctx, ModelLookupConfig{Provider: "openai", Endpoint: "https://models.example.test/v1", APIKey: "key"})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("error = %v, want context.Canceled", err)
	}
}
