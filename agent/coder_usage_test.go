package agent

import (
	"context"
	"encoding/json"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// A Claude Code run as 2.1.323 streams it: the quota during the run, the cost and tokens per model
// at the end.
const fakeClaudeUsageStream = `{"type":"system","subtype":"init"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.92,"resetsAt":4102444800,"status":"allowed_warning"},"seven_day":{"utilization":0.3,"resetsAt":4102444800,"status":"allowed"}}}}
{"type":"result","subtype":"success","result":"fixed","num_turns":3,"total_cost_usd":0.5,"modelUsage":{"claude-opus-5-5":{"inputTokens":100,"outputTokens":40,"cacheReadInputTokens":2000,"cacheCreationInputTokens":500,"costUSD":0.5}}}
`

func TestCoderToolRecordsClaudeUsageAndQuota(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	binDir := t.TempDir()
	writeFakeCoderExecutable(t, binDir, "claude", "cat >/dev/null\ncat <<'JSON'\n"+fakeClaudeUsageStream+"JSON\n")
	usagePath := filepath.Join(t.TempDir(), "usage.db")
	recorder := coderusage.NewRecorder(usagePath, nil)
	var progress []string
	tool := newCoderTool(coderToolDeps{
		Runner:    &execDirectSubtaskRunner{},
		RunCLI:    runCoderCLI,
		PathExtra: []string{binDir},
		Usage:     func() *coderusage.Recorder { return recorder },
	})
	ctx := WithEventSinkContext(llmstats.WithRunID(context.Background(), "run-7"), EventSinkFunc(func(_ context.Context, event Event) {
		if event.Summary != "" {
			progress = append(progress, event.Summary)
		}
	}))
	raw, err := tool.Execute(ctx, map[string]any{"coder": "claude", "task": "fix it", "cwd": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var result SubtaskResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatal(err)
	}
	if result.Status != SubtaskStatusDone || result.Output != "fixed" {
		t.Fatalf("result = %+v", result)
	}
	// The result tells the agent what the run used and what is left.
	for _, want := range []string{"claude run: 2.6k in (2.0k cached) · 40 out · $0.50 at list price · 3 turns", "claude quota: 5h 92% used", "7d 30% used"} {
		if !strings.Contains(result.Usage, want) {
			t.Fatalf("usage = %q, want %q", result.Usage, want)
		}
	}
	// The activity ends with the same line.
	if last := progress[len(progress)-1]; !strings.HasPrefix(last, "[claude] usage: claude run:") {
		t.Fatalf("last progress = %q (all: %q)", last, progress)
	}

	store, err := llmstats.OpenUsageStore(ctx, usagePath, llmstats.UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	records, err := store.Records(ctx, 10)
	if err != nil || len(records) != 1 {
		t.Fatalf("records = %+v, %v", records, err)
	}
	if rec := records[0]; rec.APIHost != "claude-code" || rec.Model != "claude-opus-5-5" || rec.RunID != "run-7" || rec.InputTokens != 2600 || rec.TotalCost != 0.5 {
		t.Fatalf("record = %+v", rec)
	}
	quotas, err := coderusage.LoadQuotas(ctx, store)
	if err != nil || len(quotas) != 1 || quotas[0].Backend != "claude" || quotas[0].Status != coderusage.StatusWarning {
		t.Fatalf("quotas = %+v, %v", quotas, err)
	}
}

func TestCoderToolReadsCodexQuotaAfterACodexRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	binDir := t.TempDir()
	writeFakeCoderExecutable(t, binDir, "codex", "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1500,\"cached_input_tokens\":1000,\"output_tokens\":20}}' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ok\"}}' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":500,\"cached_input_tokens\":0,\"output_tokens\":10}}'\n")
	usagePath := filepath.Join(t.TempDir(), "usage.db")
	recorder := coderusage.NewRecorder(usagePath, nil)
	var readWith []string
	tool := newCoderTool(coderToolDeps{
		Runner:    &execDirectSubtaskRunner{},
		RunCLI:    runCoderCLI,
		PathExtra: []string{binDir},
		Usage:     func() *coderusage.Recorder { return recorder },
		ReadCodexQuota: func(_ context.Context, pathExtra []string) (coderusage.Quota, error) {
			readWith = pathExtra
			used := 100.0
			return coderusage.Quota{Backend: "codex", Plan: "pro", Status: coderusage.StatusRejected, ObservedAt: "2026-11-13T09:00:00Z",
				Windows: []coderusage.Window{{Kind: "primary", WindowMinutes: 10080, UsedPercent: &used, Status: coderusage.StatusRejected}}}, nil
		},
	})
	raw, err := tool.Execute(context.Background(), map[string]any{"coder": "codex", "task": "check", "cwd": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var result SubtaskResult
	_ = json.Unmarshal([]byte(raw), &result)
	// Two turns summed; the quota read with the coder's own PATH additions.
	if !strings.Contains(result.Usage, "codex run: 2.0k in (1.0k cached) · 30 out · 2 turns") ||
		!strings.Contains(result.Usage, "codex quota: 7d 100% used (limit reached); the limit is reached") {
		t.Fatalf("usage = %q", result.Usage)
	}
	if len(readWith) != 1 || readWith[0] != binDir {
		t.Fatalf("read with %q", readWith)
	}
}

func TestCoderToolWithoutUsageRecorderStillReports(t *testing.T) {
	tool := newCoderTool(coderToolDeps{
		Runner: &execDirectSubtaskRunner{},
		RunCLI: func(_ context.Context, req CoderRequest, _ func(string)) (string, error) {
			req.Report(coderusage.Run{Models: []coderusage.ModelUsage{{Model: "codex", InputTokens: 10, OutputTokens: 2}}, Turns: 1}, nil)
			return "done", nil
		},
	})
	raw, err := tool.Execute(context.Background(), map[string]any{"coder": "codex", "task": "x", "cwd": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var result SubtaskResult
	_ = json.Unmarshal([]byte(raw), &result)
	if result.Usage != "codex run: 10 in · 2 out · 1 turn" {
		t.Fatalf("usage = %q", result.Usage)
	}
}
