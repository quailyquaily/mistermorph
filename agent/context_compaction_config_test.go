package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/tools"
)

func TestRunRejectsInvalidContextCompactionConfig(t *testing.T) {
	client := newMockClient(finalResponse("unexpected"))
	engine := New(client, tools.NewRegistry(), Config{
		ContextCompaction: ContextCompactionConfig{TriggerRatio: 1},
	}, DefaultPromptSpec())

	_, _, err := engine.Run(context.Background(), "task", RunOptions{})
	if err == nil || !strings.Contains(err.Error(), "context compaction trigger ratio") {
		t.Fatalf("Run() error = %v", err)
	}
	if calls := client.allCalls(); len(calls) != 0 {
		t.Fatalf("client calls = %d, want 0", len(calls))
	}
}

func TestNewContextCompactionConfigKeepsExplicitDisabledValue(t *testing.T) {
	config := NewContextCompactionConfig(false, 0.75)
	resolved := resolveContextCompactionConfig(config, false)
	if resolved.Enabled {
		t.Fatal("resolved enabled = true, want false")
	}
	if resolved.TriggerRatio != 0.75 {
		t.Fatalf("resolved config = %+v", resolved)
	}
}

func TestNewContextCompactionConfigRejectsExplicitZeroTriggerRatio(t *testing.T) {
	config := NewContextCompactionConfig(true, 0)
	if err := config.Validate(); err == nil || !strings.Contains(err.Error(), "trigger ratio") {
		t.Fatalf("Validate() error = %v, want trigger ratio error", err)
	}
}

func TestContextCompactionTriggerTokens(t *testing.T) {
	// A 200K window reserves 20K for output (a tenth, within 4K..32K); 80% of the 180K left is 144K.
	if got := ContextCompactionTriggerTokens(200_000, NewContextCompactionConfig(true, 0.8)); got != 144_000 {
		t.Fatalf("trigger = %d, want 144000", got)
	}
	// An out-of-range ratio falls back to the default.
	if got := ContextCompactionTriggerTokens(200_000, NewContextCompactionConfig(true, 1.5)); got <= 0 || got >= 180_000 {
		t.Fatalf("trigger with the default ratio = %d", got)
	}
	if got := ContextCompactionTriggerTokens(200_000, NewContextCompactionConfig(false, 0.8)); got != 0 {
		t.Fatalf("trigger with compaction off = %d, want 0", got)
	}
	if got := ContextCompactionTriggerTokens(0, NewContextCompactionConfig(true, 0.8)); got != 0 {
		t.Fatalf("trigger with an unknown window = %d, want 0", got)
	}
}
