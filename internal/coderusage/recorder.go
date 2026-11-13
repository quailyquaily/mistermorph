package coderusage

import (
	"context"
	"encoding/json"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/statepaths"
)

// The usage.db rows of a coder run: their host (one per CLI, apart from the LLM providers'), their
// operation and scene.
const (
	OperationCoder = "coder"
	hostCodex      = "codex-cli"
	hostClaude     = "claude-code"
)

// Host is the usage host a coder's runs are recorded under.
func Host(backend string) string {
	if backend == BackendClaude {
		return hostClaude
	}
	return hostCodex
}

// Records turns a run into usage.db rows, one per model, at ts.
func (r Run) Records(ctx context.Context, ts time.Time) []llmstats.RequestRecord {
	if r.Empty() {
		return nil
	}
	host := Host(r.Backend)
	out := make([]llmstats.RequestRecord, 0, len(r.Models))
	for i, m := range r.Models {
		rec := llmstats.RequestRecord{
			TS:                       ts.UTC().Format(time.RFC3339),
			RunID:                    llmstats.RunIDFromContext(ctx),
			OriginEventID:            llmstats.OriginEventIDFromContext(ctx),
			Provider:                 host,
			APIHost:                  host,
			Model:                    firstNonEmpty(m.Model, r.Backend),
			Operation:                OperationCoder,
			Scene:                    OperationCoder,
			InputTokens:              m.InputTokens,
			OutputTokens:             m.OutputTokens,
			TotalTokens:              m.InputTokens + m.OutputTokens,
			CachedInputTokens:        m.CachedInputTokens,
			CacheCreationInputTokens: m.CacheCreationInputTokens,
		}
		if m.CostUSD > 0 {
			// The CLI's price is the list price: on a subscription it is not what is billed.
			rec.CostCurrency, rec.CostEstimated, rec.TotalCost = "USD", true, m.CostUSD
		}
		// The run's duration goes on its first row only, so totals do not count it twice.
		if i == 0 {
			rec.DurationMs = r.DurationMs
		}
		out = append(out, rec)
	}
	return out
}

// Recorder writes coder runs and quotas into usage.db.
type Recorder struct {
	sink *llmstats.UsageSink
	now  func() time.Time
}

// NewRecorder writes to usage.db at path; a nil Recorder, or one with no path, records nothing.
func NewRecorder(path string, logger *slog.Logger) *Recorder {
	if strings.TrimSpace(path) == "" {
		return nil
	}
	return &Recorder{sink: llmstats.NewUsageSink(path, logger), now: time.Now}
}

var (
	defaultMu       sync.Mutex
	defaultRecorder *Recorder
	defaultPath     string
)

// Default is the recorder for this process's usage.db (file_state_dir), as the LLM clients'
// usage goes there (llmstats.WrapRuntimeClient).
func Default() *Recorder {
	path := statepaths.UsageDBPath()
	defaultMu.Lock()
	defer defaultMu.Unlock()
	if defaultRecorder == nil || defaultPath != path {
		defaultRecorder, defaultPath = NewRecorder(path, slog.Default()), path
	}
	return defaultRecorder
}

// RecordRun writes a run's usage, logging rather than returning a failure.
func (r *Recorder) RecordRun(ctx context.Context, run Run) {
	if r == nil || r.sink == nil {
		return
	}
	for _, rec := range run.Records(ctx, r.now()) {
		r.sink.Record(ctx, rec)
	}
}

// SaveQuota keeps q as its coder's last quota, unless a newer one is saved.
func (r *Recorder) SaveQuota(ctx context.Context, q Quota) {
	if r == nil || r.sink == nil || strings.TrimSpace(q.Backend) == "" {
		return
	}
	data, err := json.Marshal(q)
	if err != nil {
		return
	}
	observed := q.Observed()
	if observed.IsZero() {
		observed = r.now()
	}
	r.sink.PutCoderQuota(ctx, q.Backend, observed, data)
}

// StoreQuota keeps q as its coder's last quota in an open usage store, unless a newer one is saved.
func StoreQuota(ctx context.Context, store *llmstats.UsageStore, q Quota) error {
	data, err := json.Marshal(q)
	if err != nil {
		return err
	}
	observed := q.Observed()
	if observed.IsZero() {
		observed = time.Now()
	}
	return store.PutCoderQuota(ctx, q.Backend, observed, data)
}

// LoadQuotas reads every coder's last quota from an open usage store, by backend.
func LoadQuotas(ctx context.Context, store *llmstats.UsageStore) ([]Quota, error) {
	rows, err := store.CoderQuotas(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Quota, 0, len(rows))
	for _, row := range rows {
		var q Quota
		if err := json.Unmarshal(row.Data, &q); err != nil || strings.TrimSpace(q.Backend) == "" {
			continue
		}
		out = append(out, q)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Backend < out[j].Backend })
	return out, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v = strings.TrimSpace(v); v != "" {
			return v
		}
	}
	return ""
}
