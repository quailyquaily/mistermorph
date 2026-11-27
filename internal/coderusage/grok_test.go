package coderusage

import (
	"context"
	"slices"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// Grok Build's runs have a host of their own, never Codex's; it is not among the coders a quota
// is looked for.
func TestGrokHostAndNoQuota(t *testing.T) {
	if got := Host(BackendGrok); got != "grok-build" {
		t.Fatalf("Host(grok) = %q", got)
	}
	if got := Host(BackendCodex); got != "codex-cli" {
		t.Fatalf("Host(codex) = %q", got)
	}
	if slices.Contains(Backends, BackendGrok) {
		t.Fatalf("Backends = %v: Grok Build has no quota to read", Backends)
	}
	run := Run{Backend: BackendGrok, Turns: 1, Models: []ModelUsage{
		{Model: "grok-4.7-build", InputTokens: 18024, CachedInputTokens: 2176, OutputTokens: 31, ReasoningTokens: 30},
		{InputTokens: 5, OutputTokens: 1},
	}}
	records := run.Records(context.Background(), time.Unix(1_800_000_000, 0))
	if len(records) != 2 || records[0].APIHost != "grok-build" || records[0].Provider != "grok-build" || records[0].Model != "grok-4.7-build" ||
		records[0].Operation != llmstats.OperationCoder || records[0].InputTokens != 18024 || records[0].CachedInputTokens != 2176 || records[0].TotalTokens != 18055 {
		t.Fatalf("records = %+v", records)
	}
	// A model the CLI did not name goes under the coder's own name.
	if records[1].Model != "grok" {
		t.Fatalf("unnamed model = %q", records[1].Model)
	}
}
