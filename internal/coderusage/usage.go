// Package coderusage reads what the local coding CLIs the coder tool runs (Codex, Claude Code, the
// Antigravity CLI) report about their use: what each run used (tokens, and Claude Code's cost), and how much of the
// user's subscription quota is left (the 5-hour and weekly windows). Runs go into usage.db as LLM
// usage; the last quota of each coder is kept beside them (llmstats.UsageStore.PutCoderQuota).
//
// Sources, each the CLI's own:
//
//   - Codex: a session's rollout files record each response's tokens and model; its quota comes
//     only from the app server's `account/rateLimits/read` (the session's own server after a
//     task, ReadCodexQuota for a refresh), which uses no quota itself.
//
//   - Claude Code: a `claude -p` stream session reports the quota in a `rate_limit_event` during
//     a task, and the task's cost and tokens per model in the `result` line that ends it
//     (`model_usage_since_last_result`); a refresh reads `claude -p /usage` (ReadClaudeQuota).
//
//   - Antigravity CLI: an `agy acp` prompt's result carries its `usage` (tokens, no cost); its
//     quota, per model group, comes from `agy -p /usage --output-format json` (ReadAgyQuota),
//     which the CLI answers itself.
//
// Nothing here reads the CLIs' credentials or calls their services directly.
package coderusage

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// The coders, as the coder tool names them.
const (
	BackendCodex  = "codex"
	BackendClaude = "claude"
	BackendAgy    = "agy"
)

// Backends are the coders, in the order they are listed.
var Backends = []string{BackendCodex, BackendClaude, BackendAgy}

// ModelUsage is what one run used of one model. InputTokens counts every input token, cached
// reads and cache writes included (as llmstats counts them).
type ModelUsage struct {
	Model                    string
	InputTokens              int64
	CachedInputTokens        int64
	CacheCreationInputTokens int64
	OutputTokens             int64
	ReasoningTokens          int64
	// CostUSD is the CLI's own cost of the run, at list price (Claude Code); 0 when it gives none.
	CostUSD float64
	// CacheDetails splits CacheCreationInputTokens by the cache's lifetime, under the CLI's names
	// (ephemeral_5m_input_tokens, ephemeral_1h_input_tokens), when the CLI says: they have
	// different prices.
	CacheDetails map[string]int64
	// Requests are the model's upstream requests the usage sums, when the CLI tells them apart
	// and gives no cost (Codex's rollout files). The pricing catalog prices a request,
	// not a run: the row is priced request by request (llmstats.RequestRecord.PricingParts).
	Requests []RequestUsage
}

// RequestUsage is what one upstream request of a run used; the fields are ModelUsage's.
type RequestUsage struct {
	InputTokens              int64
	CachedInputTokens        int64
	CacheCreationInputTokens int64
	OutputTokens             int64
	CacheDetails             map[string]int64
	// Count is how many such requests; 0 means 1. -1 takes back a request an earlier run of the
	// session reported, which this run reports again with corrected numbers.
	Count int64
}

// Run is what one coder run used.
type Run struct {
	Backend    string
	Models     []ModelUsage
	Turns      int
	DurationMs int64
	// NotSignedIn says the run failed because the CLI had no sign-in (the Antigravity CLI).
	NotSignedIn bool
}

// Empty reports whether the run reported no usage at all.
func (r Run) Empty() bool {
	for _, m := range r.Models {
		if m.InputTokens > 0 || m.OutputTokens > 0 || m.CostUSD > 0 {
			return false
		}
	}
	return true
}

// Total is the run's usage over its models.
func (r Run) Total() ModelUsage {
	var total ModelUsage
	for _, m := range r.Models {
		total.InputTokens += m.InputTokens
		total.CachedInputTokens += m.CachedInputTokens
		total.CacheCreationInputTokens += m.CacheCreationInputTokens
		total.OutputTokens += m.OutputTokens
		total.ReasoningTokens += m.ReasoningTokens
		total.CostUSD += m.CostUSD
	}
	return total
}

// Cost is the run's cost at list price, as its usage.db rows carry it: the pricing catalog's
// price of each model's usage, or the CLI's own (Claude Code) for a model the catalog has no
// price for. A model with neither adds nothing; 0 when no model has a price.
func (r Run) Cost() float64 {
	// Without a catalog the rows keep what the CLI gave.
	catalog, _, _ := llmstats.DefaultPricing()
	var total float64
	for _, rec := range r.Records(context.Background(), time.Now()) {
		total += llmstats.PriceRecord(rec, catalog).TotalCost
	}
	return total
}

// Summary is one line for the run's activity and the tool result, e.g.
// "48.2k in (31.0k cached) · 3.1k out · $0.21 at list price · 6 turns". The cost is Cost: the
// catalog's price, which the run's rows carry.
func (r Run) Summary() string {
	if r.Empty() {
		return ""
	}
	total := r.Total()
	parts := []string{CompactTokens(total.InputTokens) + " in"}
	if total.CachedInputTokens > 0 {
		parts[0] += " (" + CompactTokens(total.CachedInputTokens) + " cached)"
	}
	parts = append(parts, CompactTokens(total.OutputTokens)+" out")
	if cost := r.Cost(); cost >= 0.01 {
		parts = append(parts, fmt.Sprintf("$%.2f at list price", cost))
	} else if cost > 0 {
		// A small run: cents would say $0.00.
		parts = append(parts, fmt.Sprintf("$%.4f at list price", cost))
	}
	if r.Turns > 0 {
		unit := "turns"
		if r.Turns == 1 {
			unit = "turn"
		}
		parts = append(parts, fmt.Sprintf("%d %s", r.Turns, unit))
	}
	return strings.Join(parts, " · ")
}

// CompactTokens writes a count as 950, 48.2k or 1.3M.
func CompactTokens(n int64) string {
	switch {
	case n < 1000:
		return fmt.Sprintf("%d", n)
	case n < 1_000_000:
		return fmt.Sprintf("%.1fk", float64(n)/1000)
	default:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	}
}

// CodexTurnUsage reads a Codex `turn.completed` event's usage.
func CodexTurnUsage(payload map[string]any) (ModelUsage, bool) {
	usage, ok := payload["usage"].(map[string]any)
	if !ok {
		return ModelUsage{}, false
	}
	return ModelUsage{
		Model:                    BackendCodex,
		InputTokens:              intField(usage, "input_tokens"),
		CachedInputTokens:        intField(usage, "cached_input_tokens"),
		CacheCreationInputTokens: intField(usage, "cache_write_input_tokens"),
		OutputTokens:             intField(usage, "output_tokens"),
		ReasoningTokens:          intField(usage, "reasoning_output_tokens"),
	}, true
}

// ClaudeTaskUsage reads what one task used from the `result` line that ends it in a `claude -p`
// stream session: `model_usage_since_last_result`, per model the tokens, the cache reads and
// writes and the CLI's cost at list price, and the line's `num_turns`. The line's `modelUsage` and
// `total_cost_usd` are running totals of the process, never a task's usage: a line without
// `model_usage_since_last_result` gives no usage.
func ClaudeTaskUsage(payload map[string]any) (task []ModelUsage, turns int) {
	since, _ := payload["model_usage_since_last_result"].(map[string]any)
	return claudeModelUsage(since), int(intField(payload, "num_turns"))
}

// claudeModelUsage reads a `result` line's usage by model, in the order of the models' names.
// Input counts the cache reads and writes, as llmstats counts every input token.
func claudeModelUsage(byModel map[string]any) []ModelUsage {
	names := make([]string, 0, len(byModel))
	for name := range byModel {
		names = append(names, name)
	}
	sort.Strings(names)
	var models []ModelUsage
	for _, name := range names {
		usage, isMap := byModel[name].(map[string]any)
		if !isMap || strings.TrimSpace(name) == "" {
			continue
		}
		read := intField(usage, "cacheReadInputTokens")
		write := intField(usage, "cacheCreationInputTokens")
		models = append(models, ModelUsage{
			Model:                    strings.TrimSpace(name),
			InputTokens:              intField(usage, "inputTokens") + read + write,
			CachedInputTokens:        read,
			CacheCreationInputTokens: write,
			OutputTokens:             intField(usage, "outputTokens"),
			ReasoningTokens:          intField(usage, "thinkingTokens"),
			CostUSD:                  floatField(usage, "costUSD"),
		})
	}
	return models
}

func intField(m map[string]any, key string) int64 {
	switch v := m[key].(type) {
	case float64:
		if v < 0 || math.IsNaN(v) || math.IsInf(v, 0) {
			return 0
		}
		return int64(v)
	case int64:
		return max(v, 0)
	case int:
		return int64(max(v, 0))
	}
	return 0
}

func floatField(m map[string]any, key string) float64 {
	if v, ok := m[key].(float64); ok && v > 0 && !math.IsInf(v, 0) {
		return v
	}
	return 0
}
