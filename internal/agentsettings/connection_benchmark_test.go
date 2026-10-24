package agentsettings

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/llmutil"
)

func TestRunConnectionTestPicksBenchmarksByAbility(t *testing.T) {
	var mu sync.Mutex
	paths := map[string]int{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		paths[r.URL.Path]++
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		if strings.HasSuffix(r.URL.Path, "/audio/transcriptions") {
			_, _ = w.Write([]byte(`{"text":"The quick brown fox jumps over the lazy dog."}`))
			return
		}
		http.Error(w, `{"error":{"message":"this model only transcribes"}}`, http.StatusBadRequest)
	}))
	defer server.Close()

	cases := []struct {
		name      string
		provider  string
		abilities []string
		wantIDs   []string
	}{
		{name: "transcription only", provider: "openai", abilities: []string{"transcription"}, wantIDs: []string{"transcription"}},
		{name: "provider without transcription", provider: "anthropic", abilities: []string{"transcription"}, wantIDs: []string{"transcription"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			mu.Lock()
			clear(paths)
			mu.Unlock()
			values := llmutil.RuntimeValues{
				Provider:  tc.provider,
				Endpoint:  server.URL + "/v1",
				APIKey:    "test-key",
				Model:     "whisper-large-v3-turbo",
				Abilities: tc.abilities,
			}
			result, err := RunConnectionTest(context.Background(), values, ConnectionTestOptions{})
			if err != nil {
				t.Fatalf("RunConnectionTest() error = %v", err)
			}
			if len(result.Benchmarks) != len(tc.wantIDs) {
				t.Fatalf("benchmarks = %+v, want %v", result.Benchmarks, tc.wantIDs)
			}
			for i, id := range tc.wantIDs {
				if result.Benchmarks[i].ID != id {
					t.Fatalf("benchmark %d = %q, want %q", i, result.Benchmarks[i].ID, id)
				}
			}
			mu.Lock()
			defer mu.Unlock()
			for path := range paths {
				if !strings.HasSuffix(path, "/audio/transcriptions") {
					t.Fatalf("called %s; a transcription-only profile should not chat", path)
				}
			}
			switch tc.provider {
			case "openai":
				if !result.Benchmarks[0].OK || paths["/v1/audio/transcriptions"] != 1 {
					t.Fatalf("result = %+v, calls = %v", result.Benchmarks[0], paths)
				}
			case "anthropic":
				if result.Benchmarks[0].OK || !strings.Contains(result.Benchmarks[0].Error, "does not support transcription") {
					t.Fatalf("result = %+v", result.Benchmarks[0])
				}
			}
		})
	}
}
