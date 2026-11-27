package agent

import (
	"context"
	"encoding/json"
	"math"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/codersessions"
	"github.com/quailyquaily/mistermorph/internal/coderusage"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

// Two tasks of one `claude -p` stream session, as 2.1.325 writes them: the quota during a task, and
// a result line per task. modelUsage and total_cost_usd are the process's running totals; what a
// task used is model_usage_since_last_result.
const fakeClaudeSessionScript = `n=0
while IFS= read -r line; do
  n=$((n+1))
  if [ "$n" = 1 ]; then cat <<'JSON'
{"type":"system","subtype":"init","session_id":"00000000-0000-4000-8000-000000000001"}
{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"five_hour","unifiedWindows":{"five_hour":{"utilization":0.92,"resetsAt":4102444800,"status":"allowed_warning"},"seven_day":{"utilization":0.3,"resetsAt":4102444800,"status":"allowed"}}}}
{"type":"assistant","message":{"content":[{"type":"text","text":"fixed"}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"fixed","num_turns":3,"total_cost_usd":0.5,"modelUsage":{"claude-opus-5-5":{"inputTokens":100,"outputTokens":40,"cacheReadInputTokens":2000,"cacheCreationInputTokens":500,"costUSD":0.5}},"model_usage_since_last_result":{"claude-opus-5-5":{"inputTokens":100,"outputTokens":40,"cacheReadInputTokens":2000,"cacheCreationInputTokens":500,"costUSD":0.5}}}
JSON
  else cat <<'JSON'
{"type":"assistant","message":{"content":[{"type":"text","text":"and tested"}]},"parent_tool_use_id":null}
{"type":"result","subtype":"success","is_error":false,"result":"and tested","num_turns":1,"total_cost_usd":0.8,"modelUsage":{"claude-opus-5-5":{"inputTokens":200,"outputTokens":60,"cacheReadInputTokens":5000,"cacheCreationInputTokens":500,"costUSD":0.8}},"model_usage_since_last_result":{"claude-opus-5-5":{"inputTokens":100,"outputTokens":20,"cacheReadInputTokens":3000,"cacheCreationInputTokens":0,"costUSD":0.3}}}
JSON
  fi
done
`

// coderSessionRunner runs the coder tool's tasks in real sessions under one scope, as a runtime's
// runner does (taskruntime.CoderSessionRunner) for a run that cannot ask.
func coderSessionRunner(sessions *codersessions.Sessions) func(context.Context, CoderRequest) (string, error) {
	return func(ctx context.Context, request CoderRequest) (string, error) {
		return sessions.Run(ctx, "run", codersessions.Request{
			Backend: request.Backend, Command: request.Command, Env: request.Env, CWD: request.CWD, Task: request.Task,
			BypassApprovals: true, Process: request.Process, Report: request.Report,
			Progress: func(status string) { request.Progress(status, status+"\n", status) },
			Note:     func(text string) { request.Progress("", text+"\n", "") },
		})
	}
}

// Claude Code through the session path: each task's usage and the quota arrive in one report, are
// said with the result, and become rows in usage.db with the CLI's list price. The second task of
// the process records what it used itself, not the process's running totals.
func TestCoderToolRecordsClaudeUsageAndQuota(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	binDir := t.TempDir()
	writeFakeCoderExecutable(t, binDir, "claude", fakeClaudeSessionScript)
	usagePath := filepath.Join(t.TempDir(), "usage.db")
	recorder := coderusage.NewRecorder(usagePath, nil)
	var sessions codersessions.Sessions
	defer sessions.Close()
	var progress []string
	tool := newCoderTool(coderToolDeps{
		Runner:      &execDirectSubtaskRunner{},
		RunSessions: coderSessionRunner(&sessions),
		Env:         shellenv.CoderEnv{PathExtra: []string{binDir}},
		Usage:       func() *coderusage.Recorder { return recorder },
	})
	ctx := WithEventSinkContext(llmstats.WithRunID(context.Background(), "run-7"), EventSinkFunc(func(_ context.Context, event Event) {
		if event.Summary != "" {
			progress = append(progress, event.Summary)
		}
	}))
	cwd := t.TempDir()
	run := func(task string) SubtaskResult {
		t.Helper()
		raw, err := tool.Execute(ctx, map[string]any{"coder": "claude", "task": task, "cwd": cwd})
		if err != nil {
			t.Fatal(err)
		}
		var result SubtaskResult
		if err := json.Unmarshal([]byte(raw), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	result := run("fix it")
	if result.Status != SubtaskStatusDone || result.Output != "fixed" {
		t.Fatalf("result = %+v", result)
	}
	// The result tells the agent what the task used and what is left.
	// The cost is the catalog's price of the task, as its row carries it, not the CLI's $0.50.
	for _, want := range []string{"claude run: 2.6k in (2.0k cached) · 40 out · $", " at list price · 3 turns", "claude quota: 5h 92% used", "7d 30% used"} {
		if !strings.Contains(result.Usage, want) {
			t.Fatalf("usage = %q, want %q", result.Usage, want)
		}
	}
	if strings.Contains(result.Usage, "$0.50") {
		t.Fatalf("usage = %q, should say the catalog's price", result.Usage)
	}
	// The activity ends with the same line.
	if last := progress[len(progress)-1]; !strings.HasPrefix(last, "[claude] usage: claude run:") {
		t.Fatalf("last progress = %q (all: %q)", last, progress)
	}

	// The same process takes the next task, and reports what that one used: $0.30, not the $0.80
	// the process has used by then.
	second := run("test it")
	if second.Status != SubtaskStatusDone || second.Output != "and tested" {
		t.Fatalf("second result = %+v", second)
	}
	if !strings.HasPrefix(second.Usage, "claude run: 3.1k in (3.0k cached) · 20 out · $") || !strings.HasSuffix(second.Usage, " at list price · 1 turn") ||
		strings.Contains(second.Usage, "$0.30") {
		t.Fatalf("second usage = %q", second.Usage)
	}

	store, err := llmstats.OpenUsageStore(ctx, usagePath, llmstats.UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	records, err := store.Records(ctx, 10)
	if err != nil || len(records) != 2 {
		t.Fatalf("records = %+v, %v", records, err)
	}
	if rec := records[0]; rec.APIHost != "claude-code" || rec.Model != "claude-opus-5-5" || rec.RunID != "run-7" || rec.InputTokens != 2600 ||
		rec.CachedInputTokens != 2000 || rec.CacheCreationInputTokens != 500 || rec.OutputTokens != 40 ||
		// Priced from the catalog (which says what the input cost), not the CLI's $0.50.
		rec.TotalCost <= 0 || rec.TotalCost == 0.5 || rec.InputCost <= 0 || !rec.CostEstimated || rec.CostCurrency != "USD" {
		t.Fatalf("record = %+v", rec)
	}
	if rec := records[1]; rec.Model != "claude-opus-5-5" || rec.InputTokens != 3100 || rec.CachedInputTokens != 3000 || rec.CacheCreationInputTokens != 0 ||
		rec.OutputTokens != 20 || rec.TotalCost <= 0 || rec.TotalCost == 0.3 || !rec.CostEstimated {
		t.Fatalf("second record = %+v", rec)
	}
	quotas, err := coderusage.LoadQuotas(ctx, store)
	if err != nil || len(quotas) != 1 || quotas[0].Backend != "claude" || quotas[0].Status != coderusage.StatusWarning {
		t.Fatalf("quotas = %+v, %v", quotas, err)
	}
}

func TestCoderToolWithoutUsageRecorderStillReports(t *testing.T) {
	tool := newCoderTool(coderToolDeps{
		Runner: &execDirectSubtaskRunner{},
		Env:    fakeCoderEnv(t),
		RunSessions: func(_ context.Context, req CoderRequest) (string, error) {
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

// A report that carries no cost of the CLI's but the single requests (Codex's rollout files; a
// Claude Code terminal session before the stream sessions) is saved with its quota in one call,
// and the rows are priced from the catalog, request by request.
func TestCoderToolPricesAReportsRequestsFromTheCatalog(t *testing.T) {
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
		RunSessions: func(_ context.Context, req CoderRequest) (string, error) {
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
			return "fixed in the session", nil
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
	if reports != 1 || result.Status != SubtaskStatusDone || result.Output != "fixed in the session" {
		t.Fatalf("reports = %d, result = %+v", reports, result)
	}
	// The line says the catalog's price of the models it knows.
	for _, want := range []string{"claude run: 1.2M in (496.0k cached) · 23.0k out · $", " at list price · 2 turns", "claude quota: 5h 61% used"} {
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

func TestCoderSessionsReportAllBackends(t *testing.T) {
	for _, backend := range []string{"codex", "claude", "agy"} {
		t.Run(backend, func(t *testing.T) {
			reports := 0
			quotaReads := 0
			used := 25.0
			tool := newCoderTool(coderToolDeps{Runner: &execDirectSubtaskRunner{}, Env: fakeCoderEnv(t), RunSessions: func(_ context.Context, req CoderRequest) (string, error) {
				reports++
				req.Report(coderusage.Run{Turns: 1, Models: []coderusage.ModelUsage{{Model: backend, InputTokens: 100, OutputTokens: 10}}}, &coderusage.Quota{Backend: backend, Windows: []coderusage.Window{{Kind: "five_hour", WindowMinutes: 300, UsedPercent: &used}}})
				return "done", nil
			}, ReadAgyQuota: func(context.Context, shellenv.CoderEnv) (coderusage.Quota, error) {
				quotaReads++
				return coderusage.Quota{}, nil
			}})
			raw, err := tool.Execute(context.Background(), map[string]any{"coder": backend, "task": "test", "cwd": t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			var result SubtaskResult
			if err = json.Unmarshal([]byte(raw), &result); err != nil {
				t.Fatal(err)
			}
			if reports != 1 || quotaReads != 0 || !strings.Contains(result.Usage, backend+" run: 100 in") || !strings.Contains(result.Usage, "25% used") {
				t.Fatalf("reports=%d extra reads=%d result=%+v", reports, quotaReads, result)
			}
		})
	}
}

// Grok Build reports no quota: its run's usage line has no quota part, nothing is read or kept
// for it, and its usage.db row is under its own host.
func TestCoderGrokRunHasUsageAndNoQuota(t *testing.T) {
	ctx := context.Background()
	usagePath := filepath.Join(t.TempDir(), "usage.db")
	recorder := coderusage.NewRecorder(usagePath, nil)
	quotaReads := 0
	tool := newCoderTool(coderToolDeps{Runner: &execDirectSubtaskRunner{}, Env: fakeCoderEnv(t), Usage: func() *coderusage.Recorder { return recorder }, RunSessions: func(_ context.Context, req CoderRequest) (string, error) {
		req.Report(coderusage.Run{Turns: 1, Models: []coderusage.ModelUsage{{Model: "grok-4.7-build", InputTokens: 100, CachedInputTokens: 20, OutputTokens: 10}}}, nil)
		return "done", nil
	}, ReadAgyQuota: func(context.Context, shellenv.CoderEnv) (coderusage.Quota, error) {
		quotaReads++
		return coderusage.Quota{}, nil
	}})
	raw, err := tool.Execute(ctx, map[string]any{"coder": "grok", "task": "test", "cwd": t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	var result SubtaskResult
	if err = json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(result.Usage, "grok run: 100 in") || strings.Contains(result.Usage, "quota") || strings.Contains(result.Usage, "% used") || quotaReads != 0 {
		t.Fatalf("usage = %q, quota reads = %d", result.Usage, quotaReads)
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
	if r := records[0]; r.APIHost != "grok-build" || r.Provider != "grok-build" || r.Operation != llmstats.OperationCoder || r.Model != "grok-4.7-build" || r.InputTokens != 100 || r.CachedInputTokens != 20 {
		t.Fatalf("record = %+v", r)
	}
	quotas, err := coderusage.LoadQuotas(ctx, store)
	if err != nil || len(quotas) != 0 {
		t.Fatalf("quotas = %+v, %v", quotas, err)
	}
}
