// Package coderusage reads what the local coding CLIs the coder tool runs (Codex, Claude Code)
// report about their use: what each run used (tokens, and Claude Code's cost), and how much of the
// user's subscription quota is left (the 5-hour and weekly windows). Runs go into usage.db as LLM
// usage; the last quota of each coder is kept beside them (llmstats.UsageStore.PutCoderQuota).
//
// Sources, each the CLI's own:
//   - Codex: `codex exec --json` ends each turn with `turn.completed` and its `usage`; its quota
//     comes only from the app server's `account/rateLimits/read` (ReadCodexQuota), which uses no
//     quota itself.
//   - Claude Code: `claude -p --output-format stream-json` reports the quota in a
//     `rate_limit_event` during the run and the run's cost and tokens per model in `result`.
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
)

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
}

// Run is what one coder run used.
type Run struct {
	Backend    string
	Models     []ModelUsage
	Turns      int
	DurationMs int64
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

// ClaudeResultUsage reads a Claude Code `result` event: the run's usage per model (its
// `modelUsage`), else its overall `usage` and `total_cost_usd`, and the number of turns.
func ClaudeResultUsage(payload map[string]any) (models []ModelUsage, turns int, ok bool) {
	turns = int(intField(payload, "num_turns"))
	if byModel, isMap := payload["modelUsage"].(map[string]any); isMap && len(byModel) > 0 {
		names := make([]string, 0, len(byModel))
		for name := range byModel {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			usage, isMap := byModel[name].(map[string]any)
			if !isMap {
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
		if len(models) > 0 {
			return models, turns, true
		}
	}
	usage, isMap := payload["usage"].(map[string]any)
	if !isMap {
		return nil, turns, false
	}
	read := intField(usage, "cache_read_input_tokens")
	write := intField(usage, "cache_creation_input_tokens")
	return []ModelUsage{{
		Model:                    BackendClaude,
		InputTokens:              intField(usage, "input_tokens") + read + write,
		CachedInputTokens:        read,
		CacheCreationInputTokens: write,
		OutputTokens:             intField(usage, "output_tokens"),
		CostUSD:                  floatField(payload, "total_cost_usd"),
	}}, turns, true
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
