package daemonruntime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/agentsettings"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
	"github.com/spf13/viper"
)

func TestCoderQuotaRoutes(t *testing.T) {
	stateDir := t.TempDir()
	paths := testRuntimePaths(stateDir)
	store := openTestUsageStore(t, paths.UsageDBPath)
	used := 12.0
	if err := coderusage.StoreQuota(context.Background(), store, coderusage.Quota{
		Backend: "claude", Status: coderusage.StatusAllowed, ObservedAt: "2026-11-13T09:00:00Z", Source: coderusage.SourceRun,
		Windows: []coderusage.Window{{Kind: "five_hour", WindowMinutes: 300, UsedPercent: &used}},
	}); err != nil {
		t.Fatal(err)
	}

	// Codex is installed, Claude Code is not (at first); the Codex read answers once, then fails.
	origFind, origRead := findCoderCommand, readCoderQuota
	t.Cleanup(func() { findCoderCommand, readCoderQuota = origFind, origRead })
	claudeInstalled := false
	findCoderCommand = func(name string, _ shellenv.CoderEnv) (string, []string, error) {
		if name == "codex" || (name == "claude" && claudeInstalled) {
			return "/bin/" + name, nil, nil
		}
		return "", nil, errors.New("not found")
	}
	reads, claudeReads := 0, 0
	readCoderQuota = func(_ context.Context, backend string, _ shellenv.CoderEnv) (coderusage.Quota, error) {
		if backend == "claude" {
			claudeReads++
			session := 70.0
			return coderusage.Quota{Backend: "claude", Status: coderusage.StatusAllowed, ObservedAt: "2026-11-13T11:00:00Z", Source: coderusage.SourceRead,
				Windows: []coderusage.Window{{Kind: "five_hour", WindowMinutes: 300, UsedPercent: &session}}}, nil
		}
		reads++
		if reads > 1 {
			return coderusage.Quota{}, errors.New("not logged in")
		}
		weekly := 9.0
		return coderusage.Quota{Backend: "codex", Plan: "pro", Status: coderusage.StatusAllowed, ObservedAt: "2026-11-13T10:00:00Z", Source: coderusage.SourceRead,
			Windows: []coderusage.Window{{Kind: "primary", WindowMinutes: 10080, UsedPercent: &weekly}}}, nil
	}

	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{Mode: "serve", AuthToken: "token", RuntimePaths: paths})
	call := func(method, path string) (int, coderQuotaPayload) {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		var payload coderQuotaPayload
		_ = json.Unmarshal(rec.Body.Bytes(), &payload)
		return rec.Code, payload
	}

	// GET reads nothing live: the saved Claude quota, and which CLIs are here.
	code, payload := call(http.MethodGet, "/stats/coder/quota")
	if code != http.StatusOK || reads != 0 || len(payload.Quotas) != 1 || payload.Quotas[0].Backend != "claude" {
		t.Fatalf("GET = %d %+v (reads %d)", code, payload, reads)
	}
	if !payload.Available["codex"] || payload.Available["claude"] {
		t.Fatalf("available = %v", payload.Available)
	}

	// A refresh reads Codex's and keeps it.
	code, payload = call(http.MethodPost, "/stats/coder/quota/refresh")
	if code != http.StatusOK || reads != 1 || len(payload.Quotas) != 2 || payload.Quotas[1].Backend != "codex" || payload.Quotas[1].Plan != "pro" || len(payload.Errors) != 0 {
		t.Fatalf("refresh = %d %+v", code, payload)
	}
	// A failed read says why and keeps the last quota.
	code, payload = call(http.MethodPost, "/stats/coder/quota/refresh")
	if code != http.StatusOK || payload.Errors["codex"] != "not logged in" || len(payload.Quotas) != 2 {
		t.Fatalf("failed refresh = %d %+v", code, payload)
	}
	if claudeReads != 0 {
		t.Fatalf("read Claude Code's quota without the CLI: %d", claudeReads)
	}
	// With Claude Code installed, a refresh reads its quota too (/usage), whatever Codex's does.
	claudeInstalled = true
	code, payload = call(http.MethodPost, "/stats/coder/quota/refresh")
	if code != http.StatusOK || claudeReads != 1 || payload.Errors["codex"] != "not logged in" || payload.Errors["claude"] != "" {
		t.Fatalf("refresh with claude = %d %+v", code, payload)
	}
	if q := payload.Quotas[0]; q.Backend != "claude" || q.Source != coderusage.SourceRead || *q.Windows[0].UsedPercent != 70 {
		t.Fatalf("claude quota = %+v", q)
	}

	for _, c := range []struct{ method, path string }{{http.MethodPost, "/stats/coder/quota"}, {http.MethodGet, "/stats/coder/quota/refresh"}} {
		if code, _ := call(c.method, c.path); code != http.StatusMethodNotAllowed {
			t.Fatalf("%s %s = %d", c.method, c.path, code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, "/stats/coder/quota", nil)
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("without a token = %d", rec.Code)
	}
}

// The quota routes find and start a CLI as the coder tool does: in the bash tool's environment,
// with the coder's PATH and, without tools.coder.path_extra, the default install locations.
func TestCoderQuotaRoutesUseTheCoderEnvironment(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-in")
	}
	root := t.TempDir()
	paths := testRuntimePaths(filepath.Join(root, "state"))
	defaultDir := filepath.Join(root, "home", ".local", "bin")
	bashDir := filepath.Join(root, "bash")
	for _, dir := range []string{defaultDir, bashDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	envFile := filepath.Join(root, "env")
	// A stand-in app server that writes down its environment, then answers the rate limits read.
	body := "#!/bin/sh\n[ \"$1\" = app-server ] || exit 2\nenv > '" + envFile + "'\nread -r a\nprintf '%s\\n' '{\"id\":1,\"result\":{}}'\nread -r b\nread -r c\n" +
		"printf '%s\\n' '{\"id\":2,\"result\":{\"rateLimits\":{\"planType\":\"pro\",\"primary\":{\"usedPercent\":9,\"windowDurationMins\":10080,\"resetsAt\":1795046400}}}}'\n"
	if err := os.WriteFile(filepath.Join(defaultDir, "codex"), []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "/usr/bin:/bin")
	t.Setenv("SERVICE_SECRET", "do-not-leak")
	t.Setenv("CODEX_HOME", filepath.Join(root, "codex-home"))

	origEnv := coderEnvFromSettings
	t.Cleanup(func() { coderEnvFromSettings = origEnv })
	// The machine's own install locations are never searched: the test gives the list.
	coderEnvFromSettings = func(settings agentsettings.Reader) shellenv.CoderEnv {
		env := origEnv(settings)
		env.DefaultDirs = func() []string { return []string{defaultDir} }
		return env
	}
	serve := func(settings map[string]any) func(method, path string) coderQuotaPayload {
		reader := viper.New()
		for key, value := range settings {
			reader.Set(key, value)
		}
		mux := http.NewServeMux()
		RegisterRoutes(mux, RoutesOptions{Mode: "serve", AuthToken: "token", RuntimePaths: paths, AgentSettingsReader: reader})
		return func(method, path string) coderQuotaPayload {
			t.Helper()
			req := httptest.NewRequest(method, path, nil)
			req.Header.Set("Authorization", "Bearer token")
			rec := httptest.NewRecorder()
			mux.ServeHTTP(rec, req)
			var payload coderQuotaPayload
			if err := json.Unmarshal(rec.Body.Bytes(), &payload); err != nil || rec.Code != http.StatusOK {
				t.Fatalf("%s %s = %d %s", method, path, rec.Code, rec.Body.String())
			}
			return payload
		}
	}

	call := serve(map[string]any{
		"tools.bash.path_extra":        []string{bashDir},
		"tools.bash.injected_env_vars": []any{"CODEX_HOME"},
	})
	if payload := call(http.MethodGet, "/stats/coder/quota"); !payload.Available["codex"] || payload.Available["claude"] {
		t.Fatalf("available = %v, want codex from the default install location only", payload.Available)
	}
	payload := call(http.MethodPost, "/stats/coder/quota/refresh")
	if len(payload.Errors) != 0 || len(payload.Quotas) != 1 || payload.Quotas[0].Backend != "codex" || payload.Quotas[0].Plan != "pro" {
		t.Fatalf("refresh = %+v", payload)
	}
	data, err := os.ReadFile(envFile)
	if err != nil {
		t.Fatal(err)
	}
	got := "\n" + string(data)
	for _, want := range []string{
		"\nPATH=" + bashDir + ":/usr/bin:/bin:" + defaultDir + "\n",
		"\nCODEX_HOME=" + filepath.Join(root, "codex-home") + "\n",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("the read's environment lacks %q:\n%s", want, got)
		}
	}
	if strings.Contains(got, "SERVICE_SECRET") || strings.Contains(got, "do-not-leak") {
		t.Fatalf("a secret reached the quota read:\n%s", got)
	}

	// With tools.coder.path_extra set the default locations are not searched.
	call = serve(map[string]any{"tools.coder.path_extra": []string{filepath.Join(root, "empty")}})
	if payload := call(http.MethodGet, "/stats/coder/quota"); payload.Available["codex"] || payload.Available["claude"] {
		t.Fatalf("available = %v, want none", payload.Available)
	}
}
