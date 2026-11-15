package coderusage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
)

func openQuotaTestStore(t *testing.T) *llmstats.UsageStore {
	t.Helper()
	store, err := llmstats.OpenUsageStore(context.Background(), filepath.Join(t.TempDir(), "usage.db"), llmstats.UsageStoreOptions{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

// testdata/agy/usage.json is what `agy -p /usage --output-format json` printed (agy 1.5.9,
// 2026-11-15): two model groups, each with a weekly bucket.

func agyUsageFixture(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "agy", "usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestAgyUsageCountsCachedReadsAsInput(t *testing.T) {
	// The second model call of a real run: its input_tokens leaves the cached reads out.
	got := AgyUsage(decode(t, `{"input_tokens":2355,"output_tokens":192,"thinking_tokens":144,"cache_read_tokens":6612,"total_tokens":2547}`))
	want := ModelUsage{Model: "agy", InputTokens: 8967, CachedInputTokens: 6612, OutputTokens: 192, ReasoningTokens: 144}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("usage = %+v, want %+v", got, want)
	}
	run := Run{Backend: BackendAgy, Models: []ModelUsage{got}, Turns: 1}
	records := run.Records(context.Background(), time.Unix(1794550000, 0))
	if len(records) != 1 || records[0].APIHost != "antigravity-cli" || records[0].Model != "agy" || records[0].Operation != llmstats.OperationCoder ||
		records[0].Scene != llmstats.OperationCoder || records[0].InputTokens != 8967 || records[0].CachedInputTokens != 6612 || records[0].TotalTokens != 9159 || records[0].TotalCost != 0 {
		t.Fatalf("records = %+v", records)
	}
	if got := run.Summary(); got != "9.0k in (6.6k cached) · 192 out · 1 turn" {
		t.Fatalf("summary = %q", got)
	}
}

func TestParseAgyUsageTwoGroups(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 15, 22, 0, time.UTC)
	q, err := ParseAgyUsage(agyUsageFixture(t), now)
	if err != nil {
		t.Fatal(err)
	}
	if q.Backend != "agy" || q.Source != SourceRead || q.Status != StatusAllowed || len(q.Windows) != 2 || len(q.Groups) != 2 {
		t.Fatalf("quota = %+v", q)
	}
	gemini, others := q.Windows[0], q.Windows[1]
	// Used is 1 - remaining_fraction: 0.99725 left is 0.3% used.
	if gemini.Kind != "gemini-weekly" || gemini.Group != "Gemini Models" || gemini.WindowMinutes != 10080 || *gemini.UsedPercent != 0.3 ||
		gemini.ResetsAt != "2026-11-22T12:15:22Z" || gemini.Status != StatusAllowed {
		t.Fatalf("gemini = %+v", gemini)
	}
	if others.Kind != "3p-weekly" || others.Group != "Claude and GPT models" || *others.UsedPercent != 0 {
		t.Fatalf("others = %+v", others)
	}
	if q.Groups[0].Name != "Gemini Models" || strings.Join(q.Groups[0].Models, "|") != "Gemini 3.8 Flash" ||
		strings.Join(q.Groups[1].Models, "|") != "Claude Sonnet 4.6|Claude Opus 4.6|GPT-OSS 120B" {
		t.Fatalf("groups = %+v", q.Groups)
	}
	want := "agy quota: Gemini Models 7d 0% used (resets in 7d), Claude and GPT models 7d 0% used (resets in 7d)"
	if got := q.Note(now); got != want {
		t.Fatalf("note = %q, want %q", got, want)
	}
}

// A group with a five-hour and a weekly bucket (the docs name both; the five-hour bucket's word
// was not seen, so several spellings are read), and windows nearly and wholly used.
func TestParseAgyUsageWindowsAndLimits(t *testing.T) {
	now := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	data := []byte(`{"status":"SUCCESS","command":{"name":"usage","data":{"groups":[
		{"name":"Gemini Models","description":"Models within this group: Gemini 3.8 Flash, Gemini 3.8 Pro","buckets":[
			{"id":"gemini-weekly","window":"weekly","remaining_fraction":0.5,"reset_time":"2026-11-22T12:00:00Z"},
			{"id":"gemini-5h","window":"five_hour","remaining_fraction":0.06,"reset_time":"2026-11-15T15:10:00Z"}]},
		{"name":"Claude and GPT models","description":"Shared.","buckets":[
			{"id":"3p-weekly","window":"weekly","remaining_fraction":0,"reset_time":"2026-11-17T12:00:00Z"},
			{"id":"3p-odd","window":"fortnight"},
			{"id":"3p-five-hour","window":"","remaining_fraction":1}]}]}}}`)
	q, err := ParseAgyUsage(data, now)
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, w := range q.Windows {
		used := "-"
		if w.UsedPercent != nil {
			used = strconv.FormatFloat(*w.UsedPercent, 'f', -1, 64)
		}
		got = append(got, w.Group+"/"+w.Kind+"/"+WindowLabel(w)+"/"+used+"/"+w.Status)
	}
	// The CLI's order of groups; in a group the shorter windows first, an unknown length last.
	want := []string{
		"Gemini Models/gemini-5h/5h/94/allowed_warning",
		"Gemini Models/gemini-weekly/7d/50/allowed",
		"Claude and GPT models/3p-five-hour/5h/0/allowed",
		"Claude and GPT models/3p-weekly/7d/100/rejected",
		"Claude and GPT models/3p-odd/3p-odd/-/allowed",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("windows =\n%s\nwant\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// One group at its limit leaves the other's models: a warning, not the whole coder rejected.
	if q.Status != StatusWarning || len(q.Groups[1].Models) != 0 {
		t.Fatalf("status = %q, groups = %+v", q.Status, q.Groups)
	}
	note := q.Note(now)
	for _, wantText := range []string{
		"Gemini Models 5h 94% used (nearly used up) (resets in 3h10m)",
		"Claude and GPT models 7d 100% used (limit reached) (resets in 2d)",
		"; limit reached for Claude and GPT models",
	} {
		if !strings.Contains(note, wantText) {
			t.Fatalf("note = %q, want %q", note, wantText)
		}
	}

	// Every group at its limit: the coder's limit is reached.
	all, err := ParseAgyUsage([]byte(`{"status":"SUCCESS","command":{"data":{"groups":[
		{"name":"A","buckets":[{"id":"a-weekly","window":"weekly","remaining_fraction":0}]},
		{"name":"B","buckets":[{"id":"b-weekly","window":"weekly","remaining_fraction":0}]}]}}}`), now)
	if err != nil || all.Status != StatusRejected || !strings.HasSuffix(all.Note(now), "; the limit is reached") {
		t.Fatalf("quota = %+v, %v, note %q", all, err, all.Note(now))
	}
}

func TestParseAgyUsageFailures(t *testing.T) {
	now := time.Now()
	for name, tc := range map[string]struct{ data, want string }{
		"not JSON":   {"Usage panel", "agy /usage:"},
		"no groups":  {`{"status":"SUCCESS","response":"","command":{"name":"usage","data":{}}}`, "no quota reported"},
		"no command": {`{"status":"SUCCESS","response":"hello"}`, "no quota reported"},
		"error":      {`{"status":"ERROR","error":"backend unavailable\nmore"}`, "agy /usage: backend unavailable"},
	} {
		if _, err := ParseAgyUsage([]byte(tc.data), now); err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Fatalf("%s: error = %v, want %q", name, err, tc.want)
		}
	}
	if _, err := ParseAgyUsage([]byte(`{"status":"ERROR","error":"authentication failed or timed out"}`), now); !errors.Is(err, ErrAgySignIn) {
		t.Fatalf("error = %v", err)
	}
}

func TestReadAgyQuota(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("shell script stand-in")
	}
	dir := t.TempDir()
	fixture, err := filepath.Abs(filepath.Join("testdata", "agy", "usage.json"))
	if err != nil {
		t.Fatal(err)
	}
	write := func(name, body string) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
			t.Fatal(err)
		}
		return path
	}

	ok := write("agy", "[ \"$1\" = -p ] && [ \"$2\" = /usage ] && [ \"$3\" = --output-format ] && [ \"$4\" = json ] || exit 2\ncat '"+fixture+"'\n")
	q, err := ReadAgyQuota(context.Background(), ok, nil)
	if err != nil || len(q.Windows) != 2 || q.Windows[0].Group != "Gemini Models" {
		t.Fatalf("quota = %+v, %v", q, err)
	}

	// The CLI fails: its stderr says why, and no quota is made up.
	failing := write("agy-fails", "echo 'jetski: backend unavailable' >&2\nexit 1\n")
	if _, err := ReadAgyQuota(context.Background(), failing, nil); err == nil || !strings.Contains(err.Error(), "backend unavailable") {
		t.Fatalf("error = %v", err)
	}
	// A failed run's envelope says why.
	envelope := write("agy-error", "printf '%s\\n' '{\"status\":\"ERROR\",\"error\":\"quota service down\"}'\nexit 1\n")
	if _, err := ReadAgyQuota(context.Background(), envelope, nil); err == nil || !strings.Contains(err.Error(), "quota service down") {
		t.Fatalf("error = %v", err)
	}
	silent := write("agy-silent", "exit 0\n")
	if _, err := ReadAgyQuota(context.Background(), silent, nil); err == nil || !strings.Contains(err.Error(), "no output") {
		t.Fatalf("error = %v", err)
	}
	if _, err := ReadAgyQuota(context.Background(), "", nil); err == nil {
		t.Fatal("read without an executable")
	}

	// Not signed in: the read stops at the sign-in prompt instead of waiting it out, and the
	// sign-in link is not in the error.
	prompt := write("agy-signin", "printf '%s\\n' 'Authentication required. Please visit the URL to log in:' '  https://accounts.example.test/auth?x=1' 'Waiting for authentication (timeout 60s)...' >&2\nsleep 30\n")
	started := time.Now()
	_, err = ReadAgyQuota(context.Background(), prompt, nil)
	if !errors.Is(err, ErrAgySignIn) || strings.Contains(err.Error(), "example.test") {
		t.Fatalf("error = %v", err)
	}
	if elapsed := time.Since(started); elapsed > 10*time.Second {
		t.Fatalf("waited %s at the sign-in prompt", elapsed)
	}
}

func TestQuotaGroupsSurviveUsageDB(t *testing.T) {
	q, err := ParseAgyUsage(agyUsageFixture(t), time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC))
	if err != nil {
		t.Fatal(err)
	}
	store := openQuotaTestStore(t)
	ctx := context.Background()
	if err := StoreQuota(ctx, store, q); err != nil {
		t.Fatal(err)
	}
	used := 9.0
	// A quota saved before groups existed still loads.
	if err := StoreQuota(ctx, store, Quota{Backend: BackendCodex, ObservedAt: "2026-11-13T10:00:00Z", Windows: []Window{{Kind: "primary", WindowMinutes: 10080, UsedPercent: &used}}}); err != nil {
		t.Fatal(err)
	}
	quotas, err := LoadQuotas(ctx, store)
	if err != nil || len(quotas) != 2 || quotas[0].Backend != "agy" || len(quotas[0].Groups) != 2 || quotas[0].Windows[1].Group != "Claude and GPT models" ||
		quotas[1].Groups != nil || quotas[1].Windows[0].Group != "" {
		t.Fatalf("quotas = %+v, %v", quotas, err)
	}
}

// Opt in to read the installed, signed-in agy's quota (/usage: no model call).
func TestInstalledAgyUsage(t *testing.T) {
	if os.Getenv("MISTERMORPH_TEST_AGY") != "1" {
		t.Skip("set MISTERMORPH_TEST_AGY=1 to read the installed CLI's usage")
	}
	command, env, err := shellenv.CoderEnv{}.Command(BackendAgy)
	if err != nil {
		t.Fatal(err)
	}
	q, err := ReadAgyQuota(context.Background(), command, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(q.Windows) == 0 || len(q.Groups) == 0 || q.Windows[0].Group == "" {
		t.Fatalf("quota = %+v", q)
	}
	t.Log(q.Note(time.Now()))
}
