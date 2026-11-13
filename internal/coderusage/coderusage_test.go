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

// Claude Code's status line JSON, as a terminal session keeps it: the 5-hour and weekly windows
// become the quota; a gateway's spend limit, other fields and a status without windows do not.
func TestParseClaudeStatusLine(t *testing.T) {
	now := time.Date(2026, 11, 13, 13, 0, 0, 0, time.UTC)
	data := []byte(`{"session_id":"s","model":{"id":"claude-opus-5-5"},"cost":{"total_cost_usd":0.4},
		"rate_limits":{"seven_day":{"used_percentage":21.5,"resets_at":1795046400},
		"five_hour":{"used_percentage":100,"resets_at":1794580200},
		"spend_limit":{"used_percentage":3,"resets_at":1795046400}}}`)
	q, ok := ParseClaudeStatusLine(data, now)
	if !ok {
		t.Fatal("no quota")
	}
	if q.Backend != BackendClaude || q.Source != SourceRun || q.ObservedAt != "2026-11-13T13:00:00Z" || q.Status != StatusRejected {
		t.Fatalf("quota = %+v", q)
	}
	if len(q.Windows) != 2 || q.Windows[0].Kind != "five_hour" || q.Windows[1].Kind != "seven_day" {
		t.Fatalf("windows = %+v", q.Windows)
	}
	five, week := q.Windows[0], q.Windows[1]
	if five.WindowMinutes != 300 || *five.UsedPercent != 100 || five.Status != StatusRejected || five.ResetsAt != "2026-11-13T14:30:00Z" {
		t.Fatalf("5h = %+v", five)
	}
	if week.WindowMinutes != 10080 || *week.UsedPercent != 21.5 || week.Status != StatusAllowed {
		t.Fatalf("7d = %+v", week)
	}
	for _, data := range []string{`{"model":{"id":"x"}}`, `{"rate_limits":{}}`, `{"rate_limits":{"spend_limit":{"used_percentage":3}}}`, `not json`} {
		if _, ok := ParseClaudeStatusLine([]byte(data), now); ok {
			t.Fatalf("%s gave a quota", data)
		}
	}
}

// Claude Code's /usage text: the session is the 5-hour window, the weeks are 7-day ones (a
// model's own named by it), resets read in their time zone; the rest of the text is left.
func TestParseClaudeUsage(t *testing.T) {
	now := time.Date(2026, 11, 13, 14, 0, 0, 0, time.UTC) // 23:00 in Tokyo
	text := "You are currently using your subscription to power your Claude Code usage\n\n" +
		"Current session: 70% used · resets Nov 14, 12:10am (Asia/Tokyo)\n" +
		"Current week (all models): 12% used · resets Nov 20, 5am (Asia/Tokyo)\n" +
		"Current week (Fable): 100% used · resets Nov 20, 5am (Asia/Tokyo)\n\n" +
		"What's contributing to your usage?\nLast 24h · 1156 requests · 13 sessions\n  77%  Start fresh when you switch tasks · run /clear\n"
	q, err := ParseClaudeUsage(text, now)
	if err != nil {
		t.Fatal(err)
	}
	if q.Backend != BackendClaude || q.Source != SourceRead || q.Status != StatusRejected || len(q.Windows) != 3 {
		t.Fatalf("quota = %+v", q)
	}
	want := []struct {
		kind, label, resets string
		used                float64
	}{
		{"five_hour", "5h", "2026-11-13T15:10:00Z", 70},
		{"seven_day", "7d", "2026-11-19T20:00:00Z", 12},
		{"seven_day_fable", "7d fable", "2026-11-19T20:00:00Z", 100},
	}
	for i, w := range q.Windows {
		if w.Kind != want[i].kind || WindowLabel(w) != want[i].label || w.ResetsAt != want[i].resets || *w.UsedPercent != want[i].used {
			t.Fatalf("window %d = %+v (%s), want %+v", i, w, WindowLabel(w), want[i])
		}
	}
	if q.Windows[2].Status != StatusRejected || q.Windows[0].Status != StatusAllowed {
		t.Fatalf("statuses = %+v", q.Windows)
	}

	// A reset with no date is today's, or tomorrow's once passed; one in early January seen in
	// late December is next year's.
	if at, ok := parseClaudeReset("5pm (Asia/Tokyo)", now); !ok || at.UTC().Format(time.RFC3339) != "2026-11-14T08:00:00Z" {
		t.Fatalf("time alone = %v %v", at, ok)
	}
	december := time.Date(2026, 12, 30, 0, 0, 0, 0, time.UTC)
	if at, ok := parseClaudeReset("Jan 2, 9:30am (UTC)", december); !ok || at.Format(time.RFC3339) != "2027-01-02T09:30:00Z" {
		t.Fatalf("next year = %v %v", at, ok)
	}
	for _, bad := range []string{"soon", "Nov 14, 25pm (Asia/Tokyo)", "Nov 14, 5pm (Nowhere/City)"} {
		if _, ok := parseClaudeReset(bad, now); ok {
			t.Fatalf("%q read as a time", bad)
		}
	}
	// No limits: an API key, or another text.
	if _, err := ParseClaudeUsage("You are using an API key\n\nNo subscription limits apply.", now); err == nil || !strings.Contains(err.Error(), "You are using an API key") {
		t.Fatalf("api key err = %v", err)
	}
}

// Opt in to read the installed Claude Code's subscription usage (/usage: no model call).
func TestInstalledClaudeUsage(t *testing.T) {
	if os.Getenv("MISTERMORPH_TEST_CLAUDE") != "1" {
		t.Skip("set MISTERMORPH_TEST_CLAUDE=1 to read the installed CLI's usage")
	}
	command, env, err := FindCommand(BackendClaude, nil)
	if err != nil {
		t.Fatal(err)
	}
	q, err := ReadClaudeQuota(context.Background(), command, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) == 0 || q.Windows[0].Kind != "five_hour" {
		t.Fatalf("quota = %+v", q)
	}
	t.Log(q.Note(time.Now()))
}
