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
	"fmt"
	"math"
	"sort"
	"strings"
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

// Summary is one line for the run's activity and the tool result, e.g.
// "48.2k in (31.0k cached) · 3.1k out · $0.21 at list price · 6 turns".
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
	if total.CostUSD > 0 {
		parts = append(parts, fmt.Sprintf("$%.2f at list price", total.CostUSD))
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
// writes and the CLI's cost at list price. The line's `modelUsage` and `total_cost_usd` are running
// totals of the process, never a task's usage. Only for a CLI that does not write
// `model_usage_since_last_result` is the task's usage what `modelUsage` grew by since the totals
// of the process's task before (before; nil for its first). It returns those totals for the next
// task, and the line's `num_turns`.
func ClaudeTaskUsage(payload map[string]any, before []ModelUsage) (task, totals []ModelUsage, turns int) {
	turns = int(intField(payload, "num_turns"))
	running, _ := payload["modelUsage"].(map[string]any)
	totals = claudeModelUsage(running)
	if since, ok := payload["model_usage_since_last_result"]; ok {
		byModel, _ := since.(map[string]any)
		return claudeModelUsage(byModel), totals, turns
	}
	earlier := make(map[string]ModelUsage, len(before))
	for _, m := range before {
		earlier[m.Model] = m
	}
	for _, m := range totals {
		e := earlier[m.Model]
		m.InputTokens = max(m.InputTokens-e.InputTokens, 0)
		m.CachedInputTokens = max(m.CachedInputTokens-e.CachedInputTokens, 0)
		m.CacheCreationInputTokens = max(m.CacheCreationInputTokens-e.CacheCreationInputTokens, 0)
		m.OutputTokens = max(m.OutputTokens-e.OutputTokens, 0)
		m.ReasoningTokens = max(m.ReasoningTokens-e.ReasoningTokens, 0)
		m.CostUSD = max(m.CostUSD-e.CostUSD, 0)
		if m.InputTokens > 0 || m.OutputTokens > 0 || m.CostUSD > 0 {
			task = append(task, m)
		}
	}
	return task, totals, turns
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
