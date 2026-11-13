package coderusage

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
)

// The events below are as Claude Code 2.1.323 and Codex 0.169.0 wrote them (2026-11-13).
const (
	claudeRateLimitEvent  = `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1794564600,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false,"unifiedWindows":{"five_hour":{"utilization":0.12,"resetsAt":1794564600,"status":"allowed"},"seven_day":{"utilization":0.02,"resetsAt":1795118400,"status":"allowed"}}}}`
	claudeResult          = `{"type":"result","subtype":"success","num_turns":1,"total_cost_usd":0.09425,"usage":{"input_tokens":2,"cache_creation_input_tokens":11486,"cache_read_input_tokens":11370,"output_tokens":4},"modelUsage":{"claude-opus-5-5":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":11370,"cacheCreationInputTokens":11486,"costUSD":0.09425,"thinkingTokens":0}}}`
	codexTurnCompleted    = `{"type":"turn.completed","usage":{"input_tokens":17664,"cached_input_tokens":12160,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}`
	codexRateLimitsResult = `{"ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":9,"windowDurationMins":10080,"resetsAt":1795099901},"secondary":null,"credits":{"hasCredits":true,"unlimited":false,"balance":"60864.73"},"planType":"pro","rateLimitReachedType":null},"rateLimitsByLimitId":{},"rateLimitResetCredits":{"availableCount":1}}`
)

func decode(t *testing.T, raw string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(raw), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestClaudeRateLimitEvent(t *testing.T) {
	now := time.Unix(1794550000, 0)
	q, ok := ParseClaudeRateLimit(decode(t, claudeRateLimitEvent)["rate_limit_info"].(map[string]any), now)
	if !ok {
		t.Fatal("not parsed")
	}
	if q.Backend != BackendClaude || q.Status != StatusAllowed || q.Source != SourceRun || len(q.Windows) != 2 {
		t.Fatalf("quota = %+v", q)
	}
	five, week := q.Windows[0], q.Windows[1]
	if five.Kind != "five_hour" || five.WindowMinutes != 300 || *five.UsedPercent != 12 || five.ResetsAt != "2026-11-13T10:10:00Z" {
		t.Fatalf("five hour = %+v", five)
	}
	if week.Kind != "seven_day" || week.WindowMinutes != 10080 || *week.UsedPercent != 2 {
		t.Fatalf("seven day = %+v", week)
	}
	if got := q.Note(now); got != "claude quota: 5h 12% used (resets in 4h03m), 7d 2% used (resets in 6d 13h)" {
		t.Fatalf("note = %q", got)
	}
}

func TestClaudeRateLimitWithoutWindows(t *testing.T) {
	info := map[string]any{"status": "rejected", "rateLimitType": "seven_day_opus", "resetsAt": float64(1795118400)}
	q, ok := ParseClaudeRateLimit(info, time.Unix(1794550000, 0))
	if !ok || q.Status != StatusRejected || len(q.Windows) != 1 {
		t.Fatalf("quota = %+v, %v", q, ok)
	}
	w := q.Windows[0]
	if w.UsedPercent != nil || WindowLabel(w) != "7d opus" || w.Status != StatusRejected {
		t.Fatalf("window = %+v (%s)", w, WindowLabel(w))
	}
	if note := q.Note(time.Unix(1794550000, 0)); !strings.Contains(note, "7d opus (limit reached)") || !strings.HasSuffix(note, "the limit is reached") {
		t.Fatalf("note = %q", note)
	}
	if _, ok := ParseClaudeRateLimit(map[string]any{"status": "allowed"}, time.Now()); ok {
		t.Fatal("an event without a window parsed")
	}
}

func TestClaudeResultUsage(t *testing.T) {
	models, turns, ok := ClaudeResultUsage(decode(t, claudeResult))
	if !ok || turns != 1 || len(models) != 1 {
		t.Fatalf("models = %+v, turns %d, %v", models, turns, ok)
	}
	m := models[0]
	// Input counts the cache reads and writes, as llmstats does for Anthropic.
	if m.Model != "claude-opus-5-5" || m.InputTokens != 2+11370+11486 || m.CachedInputTokens != 11370 || m.CacheCreationInputTokens != 11486 || m.OutputTokens != 4 || m.CostUSD != 0.09425 {
		t.Fatalf("model usage = %+v", m)
	}
	// Without modelUsage, the overall usage and cost.
	payload := decode(t, claudeResult)
	delete(payload, "modelUsage")
	models, _, ok = ClaudeResultUsage(payload)
	if !ok || models[0].Model != BackendClaude || models[0].InputTokens != 22858 || models[0].CostUSD != 0.09425 {
		t.Fatalf("fallback = %+v", models)
	}
}

func TestCodexTurnUsageAndRun(t *testing.T) {
	m, ok := CodexTurnUsage(decode(t, codexTurnCompleted))
	if !ok || m.InputTokens != 17664 || m.CachedInputTokens != 12160 || m.OutputTokens != 5 {
		t.Fatalf("usage = %+v", m)
	}
	run := Run{Backend: BackendCodex, Models: []ModelUsage{m}, Turns: 1, DurationMs: 4200}
	if got := run.Summary(); got != "17.7k in (12.2k cached) · 5 out · 1 turn" {
		t.Fatalf("summary = %q", got)
	}
	if (Run{Backend: BackendCodex}).Summary() != "" || !(Run{}).Empty() {
		t.Fatal("an empty run says something")
	}
}

func TestCodexRateLimits(t *testing.T) {
	now := time.Unix(1794550000, 0)
	q, err := ParseCodexRateLimits(json.RawMessage(codexRateLimitsResult), now)
	if err != nil {
		t.Fatal(err)
	}
	if q.Backend != BackendCodex || q.Plan != "pro" || q.Status != StatusAllowed || q.Source != SourceRead || len(q.Windows) != 1 {
		t.Fatalf("quota = %+v", q)
	}
	w := q.Windows[0]
	if w.Kind != "primary" || WindowLabel(w) != "7d" || *w.UsedPercent != 9 || w.ResetsAt != "2026-11-19T14:51:41Z" {
		t.Fatalf("window = %+v", w)
	}
	reached := strings.Replace(codexRateLimitsResult, `"rateLimitReachedType":null`, `"rateLimitReachedType":"rate_limit_reached"`, 1)
	q, err = ParseCodexRateLimits(json.RawMessage(reached), now)
	if err != nil || q.Status != StatusRejected {
		t.Fatalf("reached = %+v, %v", q, err)
	}
	if _, err := ParseCodexRateLimits(json.RawMessage(`{"rateLimits":{}}`), now); err == nil {
		t.Fatal("no windows and no plan parsed")
	}
}

func TestRecordsAndQuotasInUsageDB(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.db")
	recorder := NewRecorder(path, nil)
	recorder.now = func() time.Time { return time.Date(2026, 11, 13, 9, 0, 0, 0, time.UTC) }
	ctx := llmstats.WithRunID(context.Background(), "run-1")
	models, turns, _ := ClaudeResultUsage(decode(t, claudeResult))
	recorder.RecordRun(ctx, Run{Backend: BackendClaude, Models: models, Turns: turns, DurationMs: 1200})
	quota, _ := ParseClaudeRateLimit(decode(t, claudeRateLimitEvent)["rate_limit_info"].(map[string]any), time.Unix(1794550000, 0))
	recorder.SaveQuota(ctx, quota)
	// An older report does not replace a newer one.
	older := quota
	older.ObservedAt = "2026-11-01T00:00:00Z"
	older.Status = StatusRejected
	recorder.SaveQuota(ctx, older)

	store, err := llmstats.OpenUsageStore(ctx, path, llmstats.UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	records, err := store.Records(ctx, 10)
	if err != nil || len(records) != 1 {
		t.Fatalf("records = %+v, %v", records, err)
	}
	rec := records[0]
	if rec.APIHost != "claude-code" || rec.Model != "claude-opus-5-5" || rec.Operation != OperationCoder || rec.RunID != "run-1" ||
		rec.TotalCost != 0.09425 || !rec.CostEstimated || rec.InputTokens != 22858 || rec.DurationMs != 1200 {
		t.Fatalf("record = %+v", rec)
	}
	quotas, err := LoadQuotas(ctx, store)
	if err != nil || len(quotas) != 1 || quotas[0].Status != StatusAllowed || len(quotas[0].Windows) != 2 {
		t.Fatalf("quotas = %+v, %v", quotas, err)
	}
	// Nil recorders record nothing.
	var none *Recorder
	none.RecordRun(ctx, Run{Backend: BackendCodex})
	none.SaveQuota(ctx, quota)
	if NewRecorder("", nil) != nil {
		t.Fatal("a recorder without a path")
	}
}

func TestReadCodexQuotaFromAppServer(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-in")
	}
	dir := t.TempDir()
	script := filepath.Join(dir, "codex")
	// A stand-in app server: it checks the subcommand, answers initialize, sends a notification,
	// then answers the rate limits read.
	body := "#!/bin/sh\n[ \"$1\" = app-server ] || exit 2\nread -r a\nprintf '%s\\n' '{\"id\":1,\"result\":{}}'\nread -r b\nread -r c\n" +
		"printf '%s\\n' '{\"method\":\"account/rateLimits/updated\",\"params\":{}}'\n" +
		"printf '%s\\n' '{\"id\":2,\"result\":" + codexRateLimitsResult + "}'\nsleep 5\n"
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	q, err := ReadCodexQuota(context.Background(), script, nil)
	if err != nil {
		t.Fatal(err)
	}
	if q.Plan != "pro" || len(q.Windows) != 1 {
		t.Fatalf("quota = %+v", q)
	}
	// The server is stopped once it answered, not waited for.
	if time.Since(started) > 4*time.Second {
		t.Fatalf("read took %s", time.Since(started))
	}

	errorScript := filepath.Join(dir, "codex-error")
	body = "#!/bin/sh\nread -r a\nread -r b\nread -r c\nprintf '%s\\n' '{\"id\":2,\"error\":{\"message\":\"not logged in\"}}'\n"
	if err := os.WriteFile(errorScript, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := ReadCodexQuota(context.Background(), errorScript, nil); err == nil || !strings.Contains(err.Error(), "not logged in") {
		t.Fatalf("error = %v", err)
	}
}

func TestFindCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix permissions")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "codex"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", "")
	path, env, err := FindCommand("codex", []string{dir})
	if err != nil || path != filepath.Join(dir, "codex") {
		t.Fatalf("path = %q, %v", path, err)
	}
	if !strings.Contains(strings.Join(env, "\n"), "PATH="+string(os.PathListSeparator)+dir) {
		t.Fatalf("env lacks the extra path: %v", env)
	}
	if _, _, err := FindCommand("codex", []string{"relative/dir"}); err == nil {
		t.Fatal("found in a relative directory")
	}
}
