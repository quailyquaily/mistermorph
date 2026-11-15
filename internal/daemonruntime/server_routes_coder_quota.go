package daemonruntime

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentsettings"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

// findCoderCommand and readCoderQuota are the CLI lookups the quota routes use (tests replace
// them): Codex's app server, Claude Code's /usage; neither uses quota. The CLIs are found and
// started as the coder tool does it: in the bash tool's environment, with the coder's PATH.
var (
	// coderEnvFromSettings reads the coder's environment settings for a request.
	coderEnvFromSettings = func(settings agentsettings.Reader) shellenv.CoderEnv {
		return shellenv.CoderEnvFromConfig(settings)
	}
	findCoderCommand = func(backend string, coderEnv shellenv.CoderEnv) (string, []string, error) {
		return coderEnv.Command(backend)
	}
	readCoderQuota = func(ctx context.Context, backend string, coderEnv shellenv.CoderEnv) (coderusage.Quota, error) {
		command, env, err := findCoderCommand(backend, coderEnv)
		if err != nil {
			return coderusage.Quota{}, err
		}
		if backend == coderusage.BackendClaude {
			return coderusage.ReadClaudeQuota(ctx, command, env)
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
// /stats/coder/quota gives the last ones saved; POST /stats/coder/quota/refresh reads each
// installed coder's first, at once (Codex's app server, Claude Code's /usage).
func registerCoderQuotaRoutes(mux *http.ServeMux, authToken string, openStore func(context.Context) (*llmstats.UsageStore, error), settings agentsettings.Reader) {
	serve := func(w http.ResponseWriter, r *http.Request, refresh bool) {
		if !checkAuth(r, authToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		coderEnv := coderEnvFromSettings(settings)
		payload := coderQuotaPayload{Available: map[string]bool{}}
		for _, backend := range []string{coderusage.BackendCodex, coderusage.BackendClaude} {
			_, _, err := findCoderCommand(backend, coderEnv)
			payload.Available[backend] = err == nil
		}
		store, err := openStore(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		defer func() { _ = store.Close() }()
		if refresh {
			var mu sync.Mutex
			var wg sync.WaitGroup
			for _, backend := range []string{coderusage.BackendCodex, coderusage.BackendClaude} {
				if !payload.Available[backend] {
					continue
				}
				wg.Add(1)
				go func() {
					defer wg.Done()
					quota, err := readCoderQuota(r.Context(), backend, coderEnv)
					mu.Lock()
					defer mu.Unlock()
					if err == nil {
						err = coderusage.StoreQuota(r.Context(), store, quota)
					}
					if err != nil {
						if payload.Errors == nil {
							payload.Errors = map[string]string{}
						}
						payload.Errors[backend] = err.Error()
					}
				}()
			}
			wg.Wait()
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
