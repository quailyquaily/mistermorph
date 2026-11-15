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

	"github.com/quailyquaily/mistermorph/internal/coderusage"
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
	findCoderCommand = func(name string, _ []string) (string, []string, error) {
		if name == "codex" || (name == "claude" && claudeInstalled) {
			return "/bin/" + name, nil, nil
		}
		return "", nil, errors.New("not found")
	}
	reads, claudeReads := 0, 0
	readCoderQuota = func(_ context.Context, backend string, _ []string) (coderusage.Quota, error) {
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

// Three coders: the Antigravity CLI is found and read as the other two, with the stand-in agy the
// routes' own lookup finds on PATH, and its quota keeps its model groups.
func TestCoderQuotaRoutesWithAgy(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-in")
	}
	paths := testRuntimePaths(t.TempDir())
	binDir := t.TempDir()
	usage := `{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[` +
		`{"name":"Gemini Models","description":"Models within this group: Gemini 3.8 Flash","buckets":[{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.25,"reset_time":"2026-11-22T12:15:22Z"}]},` +
		`{"name":"Claude and GPT models","description":"Models within this group: Claude Sonnet 4.6, GPT-OSS 120B","buckets":[{"id":"3p-weekly","window":"weekly","remaining_fraction":0,"reset_time":"2026-11-22T12:15:36Z"}]}]}}}`
	script := "#!/bin/sh\nif [ -f '" + filepath.Join(binDir, "broken") + "' ]; then echo 'jetski: backend unavailable' >&2; exit 1; fi\nprintf '%s\\n' '" + usage + "'\n"
	if err := os.WriteFile(filepath.Join(binDir, "agy"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)

	mux := http.NewServeMux()
	RegisterRoutes(mux, RoutesOptions{Mode: "serve", AuthToken: "token", RuntimePaths: paths})
	call := func(method, path string) (int, coderQuotaPayload, string) {
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer token")
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		var payload coderQuotaPayload
		_ = json.Unmarshal(rec.Body.Bytes(), &payload)
		return rec.Code, payload, rec.Body.String()
	}

	code, payload, _ := call(http.MethodGet, "/stats/coder/quota")
	if code != http.StatusOK || len(payload.Quotas) != 0 || len(payload.Available) != 3 || !payload.Available["agy"] || payload.Available["codex"] || payload.Available["claude"] {
		t.Fatalf("GET = %d %+v", code, payload)
	}
	code, payload, body := call(http.MethodPost, "/stats/coder/quota/refresh")
	if code != http.StatusOK || len(payload.Quotas) != 1 || len(payload.Errors) != 0 {
		t.Fatalf("refresh = %d %+v", code, payload)
	}
	q := payload.Quotas[0]
	if q.Backend != "agy" || q.Status != coderusage.StatusWarning || len(q.Windows) != 2 || len(q.Groups) != 2 ||
		q.Windows[0].Group != "Gemini Models" || *q.Windows[0].UsedPercent != 75 || q.Windows[1].Status != coderusage.StatusRejected || *q.Windows[1].UsedPercent != 100 {
		t.Fatalf("agy quota = %+v", q)
	}
	for _, want := range []string{`"group":"Gemini Models"`, `"groups":[{"name":"Gemini Models","models":["Gemini 3.8 Flash"]}`, `"kind":"3p-weekly"`} {
		if !strings.Contains(body, want) {
			t.Fatalf("body lacks %s: %s", want, body)
		}
	}
	// A failed read says why and keeps the last quota.
	if err := os.WriteFile(filepath.Join(binDir, "broken"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	code, payload, _ = call(http.MethodPost, "/stats/coder/quota/refresh")
	if code != http.StatusOK || !strings.Contains(payload.Errors["agy"], "backend unavailable") || len(payload.Quotas) != 1 || len(payload.Quotas[0].Windows) != 2 {
		t.Fatalf("failed refresh = %d %+v", code, payload)
	}
}
