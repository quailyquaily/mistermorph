package daemonruntime

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
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
