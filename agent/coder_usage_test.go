package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
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
		Runner: &execDirectSubtaskRunner{},
		RunCLI: runCoderCLI,
		Env:    shellenv.CoderEnv{PathExtra: []string{binDir}},
		Usage:  func() *coderusage.Recorder { return recorder },
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
		Runner: &execDirectSubtaskRunner{},
		RunCLI: runCoderCLI,
		Env:    shellenv.CoderEnv{PathExtra: []string{binDir}},
		Usage:  func() *coderusage.Recorder { return recorder },
		ReadCodexQuota: func(_ context.Context, coderEnv shellenv.CoderEnv) (coderusage.Quota, error) {
			readWith = coderEnv.PathExtra
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

// A headless Codex run's stream gives each turn's sum and no model; its thread's rollout names the
// model and tells the responses apart, so the row is the model's and is priced from the catalog.
func TestCoderToolRecordsACodexRunUnderItsModelFromTheRollout(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("CODEX_HOME", "")
	const thread = "01a1d984-e368-7ad2-85e6-6ff5b9eaefb4"
	rollout := filepath.Join(home, ".codex", "sessions", "2026", "11", "14", "rollout-2026-11-14T19-05-27-"+thread+".jsonl")
	if err := os.MkdirAll(filepath.Dir(rollout), 0o755); err != nil {
		t.Fatal(err)
	}
	// Two responses of 200,000 input tokens each: apart they are below gpt-6.1-sol's 272,000 token
	// tier, summed they would be priced above it.
	response := func(total, last int) string {
		return fmt.Sprintf(`{"type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":%d,"cached_input_tokens":0,"output_tokens":%d},"last_token_usage":{"input_tokens":%d,"cached_input_tokens":0,"output_tokens":1000}}}}`+"\n", total, total/200, last)
	}
	if err := os.WriteFile(rollout, []byte(`{"type":"turn_context","payload":{"model":"gpt-6.1-sol","effort":"medium"}}`+"\n"+
		response(200_000, 200_000)+response(400_000, 200_000)+
		`{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}`+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	binDir := t.TempDir()
	writeFakeCoderExecutable(t, binDir, "codex", "cat >/dev/null\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\""+thread+"\"}' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"ok\"}}' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":400000,\"cached_input_tokens\":0,\"output_tokens\":2000}}'\n")
	usagePath := filepath.Join(t.TempDir(), "usage.db")
	recorder := coderusage.NewRecorder(usagePath, nil)
	tool := newCoderTool(coderToolDeps{
		Runner: &execDirectSubtaskRunner{},
		RunCLI: runCoderCLI,
		Env:    shellenv.CoderEnv{PathExtra: []string{binDir}},
		Usage:  func() *coderusage.Recorder { return recorder },
		ReadCodexQuota: func(context.Context, shellenv.CoderEnv) (coderusage.Quota, error) {
			return coderusage.Quota{}, errors.New("no quota")
		},
	})
	ctx := context.Background()
	raw, err := tool.Execute(ctx, map[string]any{"coder": "codex", "task": "check", "cwd": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var result SubtaskResult
	_ = json.Unmarshal([]byte(raw), &result)
	if !strings.Contains(result.Usage, "codex run: 400.0k in · 2.0k out · 1 turn") {
		t.Fatalf("usage = %q", result.Usage)
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
	// $2.00 a million input tokens and $10.00 a million output tokens, each response on its own.
	wantCost := 2 * (200_000*2.00 + 1000*10.00) / 1e6
	if rec := records[0]; rec.APIHost != "codex-cli" || rec.Model != "gpt-6.1-sol" || rec.InputTokens != 400_000 || rec.OutputTokens != 2000 ||
		len(rec.PricingParts) != 2 || !rec.CostEstimated || math.Abs(rec.TotalCost-wantCost) > 1e-9 {
		t.Fatalf("record = %+v, want cost %v", rec, wantCost)
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

// A terminal run (a Console chat) reports what its session files record and Claude Code's quota
// in one call: both are saved, and the rows are priced from the catalog, as the files carry no cost.
func TestCoderToolRecordsATerminalRunsUsageAndQuota(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	binDir := t.TempDir()
	writeFakeCoderExecutable(t, binDir, "claude", "exit 0\n")
	usagePath := filepath.Join(t.TempDir(), "usage.db")
	recorder := coderusage.NewRecorder(usagePath, nil)
	var progress []string
	reports := 0
	tool := newCoderTool(coderToolDeps{
		Runner: &execDirectSubtaskRunner{},
		Env:    shellenv.CoderEnv{PathExtra: []string{binDir}},
		Usage:  func() *coderusage.Recorder { return recorder },
		RunTerminal: func(_ context.Context, req CoderRequest) (string, error) {
			used := 61.0
			reports++
			req.Report(coderusage.Run{Turns: 2, Models: []coderusage.ModelUsage{
				{Model: "claude-opus-5-5", InputTokens: 1_000_000, CachedInputTokens: 400_000, CacheCreationInputTokens: 100_000, OutputTokens: 20_000},
				{Model: "claude-not-in-the-catalog", InputTokens: 500, OutputTokens: 5},
				// Three responses of 50,000 input tokens each, one of them writing to the 1-hour cache.
				{Model: "claude-haiku-5-5", InputTokens: 150_000, CachedInputTokens: 96_000, CacheCreationInputTokens: 48_000, OutputTokens: 3000,
					CacheDetails: map[string]int64{"ephemeral_1h_input_tokens": 48_000},
					Requests: []coderusage.RequestUsage{
						{InputTokens: 50_000, CacheCreationInputTokens: 48_000, OutputTokens: 1000, CacheDetails: map[string]int64{"ephemeral_1h_input_tokens": 48_000}},
						{InputTokens: 50_000, CachedInputTokens: 48_000, OutputTokens: 1000},
						{InputTokens: 50_000, CachedInputTokens: 48_000, OutputTokens: 1000},
					}},
			}}, &coderusage.Quota{Backend: "claude", Status: coderusage.StatusAllowed, ObservedAt: "2026-11-15T09:00:00Z",
				Windows: []coderusage.Window{{Kind: "five_hour", WindowMinutes: 300, UsedPercent: &used, Status: coderusage.StatusAllowed}}})
			return "fixed in the terminal", nil
		},
	})
	ctx := WithEventSinkContext(llmstats.WithRunID(context.Background(), "run-9"), EventSinkFunc(func(_ context.Context, event Event) {
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
	if reports != 1 || result.Status != SubtaskStatusDone || result.Output != "fixed in the terminal" {
		t.Fatalf("reports = %d, result = %+v", reports, result)
	}
	for _, want := range []string{"claude run: 1.2M in (496.0k cached) · 23.0k out · 2 turns", "claude quota: 5h 61% used"} {
		if !strings.Contains(result.Usage, want) {
			t.Fatalf("usage = %q, want %q", result.Usage, want)
		}
	}
	if last := progress[len(progress)-1]; !strings.HasPrefix(last, "[claude] usage: claude run:") {
		t.Fatalf("last progress = %q (all: %q)", last, progress)
	}

	store, err := llmstats.OpenUsageStore(ctx, usagePath, llmstats.UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	records, err := store.Records(ctx, 10)
	if err != nil || len(records) != 3 {
		t.Fatalf("records = %+v, %v", records, err)
	}
	known, unknown, byRequest := records[0], records[1], records[2]
	// A row of several requests is priced request by request, each in its own tier of the
	// catalog (claude-haiku-5-5 up to 100,000 input tokens: $0.10 in, $0.01 cached, $0.20 for a
	// 1-hour cache write, $0.50 out per 1M), not as one request of their sum.
	wantCost := 3*(2000*0.10+1000*0.50)/1e6 + 2*48_000*0.01/1e6 + 48_000*0.20/1e6
	if byRequest.Model != "claude-haiku-5-5" || byRequest.InputTokens != 150_000 || len(byRequest.PricingParts) != 3 ||
		byRequest.CacheDetails["ephemeral_1h_input_tokens"] != 48_000 ||
		math.Abs(byRequest.TotalCost-wantCost) > 1e-9 || math.Abs(byRequest.CacheCreationInputCost-48_000*0.20/1e6) > 1e-9 {
		t.Fatalf("record priced by request = %+v, want cost %v", byRequest, wantCost)
	}
	if known.APIHost != "claude-code" || known.Operation != llmstats.OperationCoder || known.Scene != llmstats.OperationCoder ||
		known.Model != "claude-opus-5-5" || known.RunID != "run-9" || known.InputTokens != 1_000_000 || known.CachedInputTokens != 400_000 ||
		known.CacheCreationInputTokens != 100_000 || known.OutputTokens != 20_000 {
		t.Fatalf("record = %+v", known)
	}
	// The catalog's list price, split by kind and marked estimated.
	if known.TotalCost <= 0 || !known.CostEstimated || known.CostCurrency != "USD" || known.OutputCost <= 0 || known.CachedInputCost <= 0 {
		t.Fatalf("record cost = %+v", known)
	}
	if unknown.Model != "claude-not-in-the-catalog" || unknown.TotalCost != 0 || unknown.CostCurrency != "" || unknown.CostEstimated {
		t.Fatalf("unknown model record = %+v", unknown)
	}
	quotas, err := coderusage.LoadQuotas(ctx, store)
	if err != nil || len(quotas) != 1 || quotas[0].Backend != "claude" || len(quotas[0].Windows) != 1 {
		t.Fatalf("quotas = %+v, %v", quotas, err)
	}
}
