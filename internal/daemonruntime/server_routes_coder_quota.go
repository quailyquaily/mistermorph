package daemonruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentsettings"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// coderQuotaPathExtraKey is where the coder tool looks for the CLIs beyond PATH.
const coderQuotaPathExtraKey = "tools.coder.path_extra"

// findCoderCommand and readCodexQuota are the CLI lookups the quota routes use (tests replace
// them).
var (
	findCoderCommand = coderusage.FindCommand
	readCodexQuota   = func(ctx context.Context, pathExtra []string) (coderusage.Quota, error) {
		command, env, err := coderusage.FindCommand(coderusage.BackendCodex, pathExtra)
		if err != nil {
			return coderusage.Quota{}, err
		}
		return coderusage.ReadCodexQuota(ctx, command, env)
	}
)

// coderQuotaPayload is the coders' last quotas, which of the CLIs this runtime finds, and, after a
// refresh, why a coder's quota could not be read.
type coderQuotaPayload struct {
	GeneratedAt string             `json:"generated_at"`
	Quotas      []coderusage.Quota `json:"quotas"`
	Available   map[string]bool    `json:"available"`
	Errors      map[string]string  `json:"errors,omitempty"`
}

// registerCoderQuotaRoutes serves the local coding CLIs' subscription quotas: GET
// /stats/coder/quota gives the last ones the coder tool saw; POST /stats/coder/quota/refresh reads
// Codex's from its app server first (Claude Code reports its quota only during a run).
func registerCoderQuotaRoutes(mux *http.ServeMux, authToken string, openStore func(context.Context) (*llmstats.UsageStore, error), settings agentsettings.Reader) {
	serve := func(w http.ResponseWriter, r *http.Request, refresh bool) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		pathExtra := settings.GetStringSlice(coderQuotaPathExtraKey)
		payload := coderQuotaPayload{Available: map[string]bool{}}
		for _, backend := range []string{coderusage.BackendCodex, coderusage.BackendClaude} {
			_, _, err := findCoderCommand(backend, pathExtra)
			payload.Available[backend] = err == nil
		}
		store, err := openStore(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer func() { _ = store.Close() }()
		if refresh && payload.Available[coderusage.BackendCodex] {
			quota, err := readCodexQuota(r.Context(), pathExtra)
			if err == nil {
				err = coderusage.StoreQuota(r.Context(), store, quota)
			}
			if err != nil {
				payload.Errors = map[string]string{coderusage.BackendCodex: err.Error()}
			}
		}
		payload.Quotas, err = coderusage.LoadQuotas(r.Context(), store)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		if payload.Quotas == nil {
			payload.Quotas = []coderusage.Quota{}
		}
		payload.GeneratedAt = time.Now().UTC().Format(time.RFC3339)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(payload)
	}
	mux.HandleFunc("/stats/coder/quota", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		serve(w, r, false)
	})
	mux.HandleFunc("/stats/coder/quota/refresh", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		serve(w, r, true)
	})
}
