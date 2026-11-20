package daemonruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	awarenessdomain "github.com/quailyquaily/mistermorph/internal/awareness"
	"github.com/quailyquaily/mistermorph/internal/dbmetrics"
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
)

func TestOverviewAddsVersionAndRuntimeWhenMissing(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "serve",
		AuthToken: "token",
		Overview: func(context.Context) (map[string]any, error) {
			return map[string]any{
				"llm": map[string]any{"provider": "openai"},
			}, nil
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/overview", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d (%s)", rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid json: %v", err)
	}

	version, _ := payload["version"].(string)
	if strings.TrimSpace(version) == "" {
		t.Fatalf("expected non-empty version, got %v", payload["version"])
	}

	runtimePayload, ok := payload["runtime"].(map[string]any)
	if !ok || runtimePayload == nil {
		t.Fatalf("expected runtime object, got %T", payload["runtime"])
	}
	for _, key := range []string{"go_version", "goroutines", "heap_alloc_bytes", "heap_sys_bytes", "heap_objects", "gc_cycles"} {
		if _, exists := runtimePayload[key]; !exists {
			t.Fatalf("expected runtime.%s in payload", key)
		}
	}
}

func TestHealthAndOverviewResolveAgentNamePerRequest(t *testing.T) {
	currentName := "Morph"
	currentAvatarURL := "https://example.test/avatar-a.png"
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:               "serve",
		AuthToken:          "token",
		HealthEnabled:      true,
		AgentNameFunc:      func() string { return currentName },
		AgentAvatarURLFunc: func() string { return currentAvatarURL },
	})

	healthReq := httptest.NewRequest(http.MethodGet, "/health", nil)
	healthRec := httptest.NewRecorder()
	mux.ServeHTTP(healthRec, healthReq)
	if healthRec.Code != http.StatusOK {
		t.Fatalf("health status = %d, want %d (%s)", healthRec.Code, http.StatusOK, healthRec.Body.String())
	}
	var healthPayload map[string]any
	if err := json.Unmarshal(healthRec.Body.Bytes(), &healthPayload); err != nil {
		t.Fatalf("health json: %v", err)
	}
	if got, _ := healthPayload["agent_name"].(string); got != "Morph" {
		t.Fatalf("health agent_name = %q, want %q", got, "Morph")
	}
	if got, _ := healthPayload["agent_avatar_url"].(string); got != currentAvatarURL {
		t.Fatalf("health agent_avatar_url = %q, want %q", got, currentAvatarURL)
	}

	currentName = "Momo"
	currentAvatarURL = "https://example.test/avatar-b.png"

	overviewReq := httptest.NewRequest(http.MethodGet, "/overview", nil)
	overviewReq.Header.Set("Authorization", "Bearer token")
	overviewRec := httptest.NewRecorder()
	mux.ServeHTTP(overviewRec, overviewReq)
	if overviewRec.Code != http.StatusOK {
		t.Fatalf("overview status = %d, want %d (%s)", overviewRec.Code, http.StatusOK, overviewRec.Body.String())
	}
	var overviewPayload map[string]any
	if err := json.Unmarshal(overviewRec.Body.Bytes(), &overviewPayload); err != nil {
		t.Fatalf("overview json: %v", err)
	}
	if got, _ := overviewPayload["agent_name"].(string); got != "Momo" {
		t.Fatalf("overview agent_name = %q, want %q", got, "Momo")
	}
	if got, _ := overviewPayload["agent_avatar_url"].(string); got != currentAvatarURL {
		t.Fatalf("overview agent_avatar_url = %q, want %q", got, currentAvatarURL)
	}
}

func TestChannelOverviewRecognizesMixinMode(t *testing.T) {
	channel := channelOverviewFromMode("mixin")
	if channel["configured"] != true || channel["mixin_configured"] != true || channel["mixin_running"] != true {
		t.Fatalf("channelOverviewFromMode(mixin) = %#v", channel)
	}
}

func TestOverviewPreservesProvidedVersionAndRuntime(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "serve",
		AuthToken: "token",
		Overview: func(context.Context) (map[string]any, error) {
			return map[string]any{
				"version": "custom-version",
				"runtime": map[string]any{
					"go_version": "custom-go",
				},
			}, nil
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/overview", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d (%s)", rec.Code, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("invalid json: %v", err)
	}

	if got, _ := payload["version"].(string); got != "custom-version" {
		t.Fatalf("expected version custom-version, got %v", payload["version"])
	}

	runtimePayload, ok := payload["runtime"].(map[string]any)
	if !ok || runtimePayload == nil {
		t.Fatalf("expected runtime object, got %T", payload["runtime"])
	}
	if got, _ := runtimePayload["go_version"].(string); got != "custom-go" {
		t.Fatalf("expected runtime.go_version custom-go, got %v", runtimePayload["go_version"])
	}
	if _, exists := runtimePayload["goroutines"]; !exists {
		t.Fatalf("expected runtime.goroutines to be backfilled")
	}
}

func TestOverviewDoesNotEmitHeartbeatRunningAlias(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "serve",
		AuthToken: "token",
		Overview: func(context.Context) (map[string]any, error) {
			return map[string]any{"awareness_running": true}, nil
		},
	})

	req := httptest.NewRequest(http.MethodGet, "/overview", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusOK, rec.Body.String())
	}

	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("overview json: %v", err)
	}
	if got, _ := payload["awareness_running"].(bool); !got {
		t.Fatalf("awareness_running = %v, want true", payload["awareness_running"])
	}
	if _, ok := payload["heartbeat_running"]; ok {
		t.Fatalf("heartbeat_running exists, want omitted")
	}
}

func TestPokeRouteTriggersAwarenessAndUpdatesOverview(t *testing.T) {
	mux := http.NewServeMux()
	calls := 0
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "serve",
		AuthToken: "token",
		Poke: func(context.Context, awarenessdomain.PokeInput) error {
			calls++
			return nil
		},
	})

	pokeReq := httptest.NewRequest(http.MethodPost, "/poke", strings.NewReader("run now"))
	pokeReq.Header.Set("Authorization", "Bearer token")
	pokeRec := httptest.NewRecorder()
	mux.ServeHTTP(pokeRec, pokeReq)
	if pokeRec.Code != http.StatusAccepted {
		t.Fatalf("poke status = %d, want %d (%s)", pokeRec.Code, http.StatusAccepted, pokeRec.Body.String())
	}
	if calls != 1 {
		t.Fatalf("poke calls = %d, want 1", calls)
	}

	var pokePayload map[string]any
	if err := json.Unmarshal(pokeRec.Body.Bytes(), &pokePayload); err != nil {
		t.Fatalf("poke json: %v", err)
	}
	pokedAt, _ := pokePayload["poked_at"].(string)
	if strings.TrimSpace(pokedAt) == "" {
		t.Fatalf("poked_at = %v, want non-empty string", pokePayload["poked_at"])
	}

	overviewReq := httptest.NewRequest(http.MethodGet, "/overview", nil)
	overviewReq.Header.Set("Authorization", "Bearer token")
	overviewRec := httptest.NewRecorder()
	mux.ServeHTTP(overviewRec, overviewReq)
	if overviewRec.Code != http.StatusOK {
		t.Fatalf("overview status = %d, want %d (%s)", overviewRec.Code, http.StatusOK, overviewRec.Body.String())
	}

	var overviewPayload map[string]any
	if err := json.Unmarshal(overviewRec.Body.Bytes(), &overviewPayload); err != nil {
		t.Fatalf("overview json: %v", err)
	}
	if got, _ := overviewPayload["last_poke_at"].(string); got != pokedAt {
		t.Fatalf("overview last_poke_at = %q, want %q", got, pokedAt)
	}
}

func TestPokeRouteRequiresAuthAndPost(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "serve",
		AuthToken: "token",
		Poke: func(context.Context, awarenessdomain.PokeInput) error {
			return nil
		},
	})

	t.Run("unauthorized", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/poke", nil)
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusUnauthorized)
		}
	})

	t.Run("method not allowed", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/poke", nil)
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusMethodNotAllowed)
		}
		if got := rec.Header().Get("Allow"); got != "POST" {
			t.Fatalf("allow = %q, want POST", got)
		}
	})

	t.Run("empty body", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/poke", nil)
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusBadRequest)
		}
	})

	t.Run("body too large", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/poke", strings.NewReader(strings.Repeat("x", pokeBodyLimit+1)))
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
		}
	})
}

func TestPokeRouteReturnsConflictWhenAwarenessAlreadyRunning(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "serve",
		AuthToken: "token",
		Poke: func(context.Context, awarenessdomain.PokeInput) error {
			return ErrPokeBusy
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/poke", strings.NewReader("run now"))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusConflict, rec.Body.String())
	}
}

func TestPokeRouteUnavailableWhenAwarenessIsNotConfigured(t *testing.T) {
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "serve",
		AuthToken: "token",
	})

	req := httptest.NewRequest(http.MethodPost, "/poke", strings.NewReader("run now"))
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusServiceUnavailable, rec.Body.String())
	}
}

func TestPokeRoutePassesBodyToCallback(t *testing.T) {
	mux := http.NewServeMux()
	var got awarenessdomain.PokeInput
	RegisterRoutes(mux, RoutesOptions{
		Mode:      "serve",
		AuthToken: "token",
		Poke: func(_ context.Context, input awarenessdomain.PokeInput) error {
			got = input
			return nil
		},
	})

	req := httptest.NewRequest(http.MethodPost, "/poke", strings.NewReader("{\"reason\":\"ci failed\"}"))
	req.Header.Set("Authorization", "Bearer token")
	req.Header.Set("Content-Type", "application/json; charset=utf-8")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusAccepted {
		t.Fatalf("status = %d, want %d (%s)", rec.Code, http.StatusAccepted, rec.Body.String())
	}
	if !got.HasBody {
		t.Fatalf("expected poke input to report body presence: %#v", got)
	}
	if got.ContentType != "application/json" {
		t.Fatalf("content type = %q, want application/json", got.ContentType)
	}
	if got.BodyText != "{\"reason\":\"ci failed\"}" {
		t.Fatalf("body text = %q, want JSON body", got.BodyText)
	}
}

func overviewRuntime(t *testing.T, mux *http.ServeMux) map[string]any {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/overview", nil)
	req.Header.Set("Authorization", "Bearer token")
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("overview status = %d (%s)", rec.Code, rec.Body.String())
	}
	var payload map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil {
		t.Fatalf("overview json: %v", err)
	}
	runtimePayload, ok := payload["runtime"].(map[string]any)
	if !ok {
		t.Fatalf("runtime = %T, want an object", payload["runtime"])
	}
	return runtimePayload
}

func TestOverviewReportsDatabaseMetrics(t *testing.T) {
	stateDir := t.TempDir()
	db, err := sqlitedb.Open(context.Background(), filepath.Join(stateDir, "memory.db"), []sqlitedb.Migration{{
		Name: "memories",
		SQL:  `CREATE TABLE memories (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO memories (body) VALUES ('a private note'), ('another');`,
	}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := os.WriteFile(filepath.Join(stateDir, "usage.db"), []byte("not a database"), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name     string
		overview OverviewFunc
	}{
		{name: "default overview"},
		// A runtime's own overview (the Console's, a channel's) brings its own runtime object.
		{name: "own overview", overview: func(context.Context) (map[string]any, error) {
			return map[string]any{"runtime": map[string]any{"go_version": "custom-go"}}, nil
		}},
		{name: "own overview without runtime", overview: func(context.Context) (map[string]any, error) {
			return map[string]any{"health": "ok"}, nil
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mux := http.NewServeMux()
			RegisterRoutes(mux, RoutesOptions{Mode: "serve", AuthToken: "token", RuntimePaths: testRuntimePaths(stateDir), Overview: tc.overview})
			runtimePayload := overviewRuntime(t, mux)
			raw, _ := json.Marshal(runtimePayload["databases"])
			if strings.Contains(string(raw), stateDir) || strings.Contains(string(raw), "private") {
				t.Fatalf("databases leak a path or content: %s", raw)
			}
			var databases []struct {
				Name      string `json:"name"`
				File      string `json:"file"`
				Status    string `json:"status"`
				SizeBytes *int64 `json:"size_bytes"`
				Tables    []struct {
					Name string `json:"name"`
					Rows *int64 `json:"rows"`
				} `json:"tables"`
			}
			if err := json.Unmarshal(raw, &databases); err != nil {
				t.Fatalf("databases = %s: %v", raw, err)
			}
			got := map[string]string{}
			for _, item := range databases {
				got[item.File] = item.Status
				switch item.File {
				case "memory.db":
					if item.SizeBytes == nil || *item.SizeBytes <= 0 {
						t.Fatalf("memory.db size = %v", item.SizeBytes)
					}
					if len(item.Tables) != 1 || item.Tables[0].Name != "memories" || item.Tables[0].Rows == nil || *item.Tables[0].Rows != 2 {
						t.Fatalf("memory.db tables = %s", raw)
					}
				case "usage.db":
					if item.SizeBytes == nil || *item.SizeBytes != 14 || item.Tables[0].Rows != nil {
						t.Fatalf("usage.db = %s, want its size and unknown rows", raw)
					}
				default:
					if item.SizeBytes != nil || item.Tables[0].Rows != nil {
						t.Fatalf("%s = %s, want unknown size and rows", item.File, raw)
					}
				}
			}
			want := map[string]string{"agent.db": "missing", "journal.db": "missing", "memory.db": "ok", "usage.db": "unavailable"}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("statuses = %v, want %v", got, want)
			}
		})
	}
}

func TestOverviewKeepsProvidedDatabaseMetricsAndOmitsThemWithoutStateDir(t *testing.T) {
	stateDir := t.TempDir()
	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{
		Mode: "serve", AuthToken: "token", RuntimePaths: testRuntimePaths(stateDir),
		Overview: func(context.Context) (map[string]any, error) {
			return map[string]any{"runtime": map[string]any{"databases": []any{}}}, nil
		},
	})
	if got, ok := overviewRuntime(t, mux)["databases"].([]any); !ok || len(got) != 0 {
		t.Fatalf("provided databases were replaced: %#v", got)
	}

	payload := map[string]any{"runtime": map[string]any{}}
	ensureDatabaseMetrics(context.Background(), payload, dbmetrics.New(""))
	if _, exists := payload["runtime"].(map[string]any)["databases"]; exists {
		t.Fatal("without a state folder the databases must stay unreported")
	}
}
