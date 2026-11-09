package llmstats

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	uniaiapi "github.com/quailyquaily/uniai"
)

func testPricing(t *testing.T, inputPerMillion string) PricingSource {
	t.Helper()
	data := []byte("version: uniai.pricing.v1\nchat:\n  - inference_provider: openai\n    model: test-model\n    input_usd_per_million: " +
		inputPerMillion + "\n    output_usd_per_million: 0\n")
	catalog, err := uniaiapi.ParsePricingYAML(data)
	if err != nil {
		t.Fatalf("ParsePricingYAML: %v", err)
	}
	return func() (*uniaiapi.PricingCatalog, string, error) { return catalog, "digest-" + inputPerMillion, nil }
}

func writeJSONL(t *testing.T, stateDir, name string, lines ...string) {
	t.Helper()
	dir := filepath.Join(stateDir, LegacyUsageJournalDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, name), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = f.Close() }()
	for _, line := range lines {
		if _, err := f.WriteString(line); err != nil {
			t.Fatal(err)
		}
	}
}

func recordLine(t *testing.T, rec RequestRecord) string {
	t.Helper()
	data, err := json.Marshal(rec)
	if err != nil {
		t.Fatal(err)
	}
	return string(data) + "\n"
}

func openTestStore(t *testing.T, path string, pricing PricingSource) *UsageStore {
	t.Helper()
	store, err := OpenUsageStore(context.Background(), path, UsageStoreOptions{Pricing: pricing})
	if err != nil {
		t.Fatalf("OpenUsageStore: %v", err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

// referenceProjection totals records the way the JSONL projection did: each valid line, priced
// from the catalog when it carries no cost, added one by one.
func referenceProjection(records []RequestRecord, catalog *uniaiapi.PricingCatalog) Projection {
	var out Projection
	byModel := map[string]*Totals{}
	byHost := map[string]*APIHostSummary{}
	byHostModel := map[string]map[string]*Totals{}
	for _, rec := range records {
		rec = backfillRequestCost(rec, catalog)
		out.Summary.AddRecord(rec)
		if byModel[rec.Model] == nil {
			byModel[rec.Model] = &Totals{}
		}
		byModel[rec.Model].AddRecord(rec)
		if byHost[rec.APIHost] == nil {
			byHost[rec.APIHost] = &APIHostSummary{APIHost: rec.APIHost}
			byHostModel[rec.APIHost] = map[string]*Totals{}
		}
		byHost[rec.APIHost].Totals.AddRecord(rec)
		if byHostModel[rec.APIHost][rec.Model] == nil {
			byHostModel[rec.APIHost][rec.Model] = &Totals{}
		}
		byHostModel[rec.APIHost][rec.Model].AddRecord(rec)
	}
	for model, totals := range byModel {
		out.Models = append(out.Models, ModelSummary{Model: model, Totals: *totals})
	}
	sortModelSummaries(out.Models)
	for host, summary := range byHost {
		for model, totals := range byHostModel[host] {
			summary.Models = append(summary.Models, ModelSummary{Model: model, Totals: *totals})
		}
		out.APIHosts = append(out.APIHosts, *summary)
	}
	sortAPIHostSummaries(out.APIHosts)
	return out
}

func totalsEqual(a, b Totals) error {
	near := func(x, y float64) bool { return math.Abs(x-y) < 1e-9 }
	if a.Requests != b.Requests || a.InputTokens != b.InputTokens || a.OutputTokens != b.OutputTokens ||
		a.TotalTokens != b.TotalTokens || a.CachedInputTokens != b.CachedInputTokens ||
		a.CacheCreationInputTokens != b.CacheCreationInputTokens || a.CostCurrency != b.CostCurrency ||
		a.CostEstimated != b.CostEstimated || !near(a.InputCost, b.InputCost) || !near(a.CachedInputCost, b.CachedInputCost) ||
		!near(a.CacheCreationInputCost, b.CacheCreationInputCost) || !near(a.OutputCost, b.OutputCost) || !near(a.TotalCost, b.TotalCost) {
		return fmt.Errorf("totals differ:\n got  %+v\n want %+v", a, b)
	}
	if len(a.CacheDetails) != len(b.CacheDetails) {
		return fmt.Errorf("cache details differ: %v vs %v", a.CacheDetails, b.CacheDetails)
	}
	for k, v := range a.CacheDetails {
		if b.CacheDetails[k] != v {
			return fmt.Errorf("cache details differ: %v vs %v", a.CacheDetails, b.CacheDetails)
		}
	}
	return nil
}

func comparableModels(t *testing.T, label string, got, want []ModelSummary) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: %d models, want %d", label, len(got), len(want))
	}
	for i := range got {
		if got[i].Model != want[i].Model {
			t.Fatalf("%s[%d] model = %q, want %q", label, i, got[i].Model, want[i].Model)
		}
		if err := totalsEqual(got[i].Totals, want[i].Totals); err != nil {
			t.Fatalf("%s %s: %v", label, got[i].Model, err)
		}
	}
}

func fixtureRecords() []RequestRecord {
	base := time.Date(2026, 3, 1, 9, 0, 0, 0, time.UTC)
	return []RequestRecord{
		{TS: base.Format(time.RFC3339), Provider: "openai", APIBase: "https://api.openai.com/v1", Model: "gpt-5.2", Scene: "agent.step",
			InputTokens: 100, OutputTokens: 10, CachedInputTokens: 40, CacheDetails: map[string]int64{"ephemeral_5m_input_tokens": 3},
			CostCurrency: "USD", CostEstimated: true, InputCost: 0.1, CachedInputCost: 0.01, OutputCost: 0.2, TotalCost: 0.31, RunID: "r1"},
		{TS: base.Add(time.Hour).Format(time.RFC3339), Provider: "openai", APIBase: "https://example.test", Model: "test-model",
			Operation: "chat", InputTokens: 1_000_000, TotalTokens: 1_000_000},
		{TS: base.Add(2 * time.Hour).Format(time.RFC3339), Provider: "anthropic", APIBase: "https://api.anthropic.com", Model: "claude-x",
			InputTokens: 5, OutputTokens: 5, CacheCreationInputTokens: 7, CacheDetails: map[string]int64{"ephemeral_5m_input_tokens": 4, "ephemeral_1h_input_tokens": 1},
			CostCurrency: "EUR", TotalCost: 1.5},
		{TS: base.Add(3 * time.Hour).Format(time.RFC3339), Provider: "openai", APIBase: "https://api.openai.com/v1", Model: "gpt-image-1",
			Operation: "image_generate", Scene: "tool.image_generate", InputTokens: 17, OutputTokens: 3, CostCurrency: "USD", TotalCost: 0.07},
		{TS: base.Add(4 * time.Hour).Format(time.RFC3339), Provider: "openai", APIBase: "https://example.test", Model: "test-model",
			Operation: "image_edit", InputTokens: 1_000_000},
		{TS: base.Add(5 * time.Hour).Format(time.RFC3339), Provider: "openai", APIBase: "https://api.openai.com/v1", Model: "gpt-5.2",
			InputTokens: 50, OutputTokens: 5, CostCurrency: "USD", TotalCost: 0.05,
			Evaluation: &EvaluationRecord{Emulated: true, Failed: true}, Operation: "evaluate"},
	}
}

func TestUsageImportMatchesProjectionTotals(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	records := fixtureRecords()
	var lines []string
	for _, rec := range records[:4] {
		lines = append(lines, recordLine(t, rec))
	}
	lines = append(lines, "not json\n", "\n", `{"ts":5}`+"\n", `{"ts":"yesterday","model":"m"}`+"\n")
	writeJSONL(t, state, "since-2026-03-01-0001.jsonl", lines...)
	writeJSONL(t, state, "since-2026-03-02-0001.jsonl", recordLine(t, records[4]), recordLine(t, records[5]))
	projectionPath := filepath.Join(state, LegacyUsageProjectionPath)
	if err := os.WriteFile(projectionPath, []byte(`{"schema_version":3}`), 0o600); err != nil {
		t.Fatal(err)
	}

	pricing := testPricing(t, "1")
	store := openTestStore(t, filepath.Join(state, "usage.db"), pricing)
	got, err := store.Usage(ctx)
	if err != nil {
		t.Fatalf("Usage: %v", err)
	}
	catalog, _, _ := pricing()
	var normalized []RequestRecord
	for _, rec := range records {
		normalized = append(normalized, normalizeRequestRecord(rec))
	}
	want := referenceProjection(normalized, catalog)
	if err := totalsEqual(got.Summary, want.Summary); err != nil {
		t.Fatalf("summary: %v", err)
	}
	if got.Summary.CostCurrency != "MIXED" {
		t.Fatalf("currency = %q, want MIXED", got.Summary.CostCurrency)
	}
	comparableModels(t, "models", got.Models, want.Models)
	if len(got.APIHosts) != len(want.APIHosts) {
		t.Fatalf("hosts = %d, want %d", len(got.APIHosts), len(want.APIHosts))
	}
	for i := range got.APIHosts {
		if got.APIHosts[i].APIHost != want.APIHosts[i].APIHost {
			t.Fatalf("host[%d] = %q, want %q", i, got.APIHosts[i].APIHost, want.APIHosts[i].APIHost)
		}
		if err := totalsEqual(got.APIHosts[i].Totals, want.APIHosts[i].Totals); err != nil {
			t.Fatalf("host %s: %v", got.APIHosts[i].APIHost, err)
		}
		comparableModels(t, "host "+got.APIHosts[i].APIHost, got.APIHosts[i].Models, want.APIHosts[i].Models)
	}
	// The chat line without a cost was priced from the catalog; the image line was not.
	if got.Summary.Requests != 6 || math.Abs(got.Summary.TotalCost-(0.31+1+1.5+0.07+0.05)) > 1e-9 {
		t.Fatalf("summary = %+v", got.Summary)
	}
	if got.SkippedRecords != 3 {
		t.Fatalf("skipped = %d, want 3", got.SkippedRecords)
	}
	rejects, err := store.ImportRejects(ctx)
	if err != nil || rejects.Count != 3 || rejects.Rejects[0].Line != 5 || rejects.Rejects[0].Source != "stats/llm_usage/since-2026-03-01-0001.jsonl" {
		t.Fatalf("rejects = %+v, %v", rejects, err)
	}

	if _, err := os.Stat(filepath.Join(state, LegacyUsageJournalDir)); !os.IsNotExist(err) {
		t.Fatalf("journal folder still in place: %v", err)
	}
	if _, err := os.Stat(filepath.Join(state, LegacyUsageJournalDir+".imported", "since-2026-03-02-0001.jsonl")); err != nil {
		t.Fatalf("imported folder: %v", err)
	}
	if _, err := os.Stat(projectionPath); !os.IsNotExist(err) {
		t.Fatalf("projection file still in place: %v", err)
	}

	// Every field round-trips through the table.
	stored, err := store.Records(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	first := stored[0]
	if first.RunID != "r1" || first.Scene != "agent.step" || first.APIBase != "https://api.openai.com/v1" || first.APIHost != "api.openai.com" ||
		first.CachedInputTokens != 40 || first.CacheDetails["ephemeral_5m_input_tokens"] != 3 || !first.CostEstimated ||
		first.CostCurrency != "USD" || first.Operation != "chat" || first.TotalTokens != 110 {
		t.Fatalf("first record = %+v", first)
	}
	if last := stored[5]; last.Evaluation == nil || !last.Evaluation.Failed || !last.Evaluation.Emulated {
		t.Fatalf("evaluation = %+v", last.Evaluation)
	}
}

func TestUsageEmptyFirstRun(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	store := openTestStore(t, filepath.Join(state, "usage.db"), testPricing(t, "1"))
	got, err := store.Usage(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if got.Summary.Requests != 0 || len(got.Models) != 0 || got.SkippedRecords != 0 {
		t.Fatalf("usage = %+v", got)
	}
	if _, err := os.Stat(filepath.Join(state, LegacyUsageJournalDir+".imported")); !os.IsNotExist(err) {
		t.Fatalf("nothing to import, but a folder was renamed: %v", err)
	}
}

func TestUsageImportCrashBeforeRenameDoesNotDuplicate(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	rec := fixtureRecords()[0]
	writeJSONL(t, state, "since-2026-03-01-0001.jsonl", recordLine(t, rec))
	dbPath := filepath.Join(state, "usage.db")
	// The import commits, then the process dies before the rename.
	backup := filepath.Join(t.TempDir(), "copy")
	if err := os.CopyFS(backup, os.DirFS(filepath.Join(state, LegacyUsageJournalDir))); err != nil {
		t.Fatal(err)
	}
	store := openTestStore(t, dbPath, testPricing(t, "1"))
	_ = store.Close()
	if err := os.Rename(filepath.Join(state, LegacyUsageJournalDir+".imported"), filepath.Join(t.TempDir(), "gone")); err != nil {
		t.Fatal(err)
	}
	if err := os.CopyFS(filepath.Join(state, LegacyUsageJournalDir), os.DirFS(backup)); err != nil {
		t.Fatal(err)
	}

	store = openTestStore(t, dbPath, testPricing(t, "1"))
	records, err := store.Records(ctx, 0)
	if err != nil || len(records) != 1 {
		t.Fatalf("records = %d, %v; want 1", len(records), err)
	}
	if _, err := os.Stat(filepath.Join(state, LegacyUsageJournalDir+".imported")); err != nil {
		t.Fatalf("reopen did not finish the rename: %v", err)
	}
}

func TestUsageRepricesAfterDigestChange(t *testing.T) {
	ctx := context.Background()
	state := t.TempDir()
	dbPath := filepath.Join(state, "usage.db")
	store := openTestStore(t, dbPath, testPricing(t, "1"))
	now := time.Now().UTC().Format(time.RFC3339)
	for _, rec := range []RequestRecord{
		{TS: now, Provider: "openai", Model: "test-model", Operation: "chat", InputTokens: 1_000_000},
		{TS: now, Provider: "openai", Model: "test-model", Operation: "chat", InputTokens: 1_000_000, CostCurrency: "USD", TotalCost: 5},
		{TS: now, Provider: "openai", Model: "other-model", Operation: "chat", InputTokens: 1_000_000},
	} {
		if err := store.Append(rec); err != nil {
			t.Fatal(err)
		}
	}
	totalCost := func() float64 {
		t.Helper()
		got, err := store.Usage(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return got.Summary.TotalCost
	}
	if got := totalCost(); math.Abs(got-6) > 1e-9 {
		t.Fatalf("cost = %v, want 6", got)
	}
	catalog, digest, _ := testPricing(t, "9")()
	if err := store.SetPricing(ctx, catalog, digest); err != nil {
		t.Fatal(err)
	}
	// The catalog-priced row is priced again; the provider-priced one keeps its cost.
	if got := totalCost(); math.Abs(got-14) > 1e-9 {
		t.Fatalf("cost after reprice = %v, want 14", got)
	}
	var saved string
	if err := store.DB().QueryRowContext(ctx, `SELECT value FROM meta WHERE key = 'pricing_digest'`).Scan(&saved); err != nil || saved != "digest-9" {
		t.Fatalf("digest = %q, %v", saved, err)
	}
	var catalogRows int
	if err := store.DB().QueryRowContext(ctx, `SELECT COUNT(*) FROM llm_requests WHERE cost_source = 'catalog'`).Scan(&catalogRows); err != nil || catalogRows != 1 {
		t.Fatalf("catalog rows = %d, %v", catalogRows, err)
	}
	// A reopen with the first catalog prices them back.
	_ = store.Close()
	store = openTestStore(t, dbPath, testPricing(t, "1"))
	if got := totalCost(); math.Abs(got-6) > 1e-9 {
		t.Fatalf("cost after reopen = %v, want 6", got)
	}
}

func TestUsageDailyAcrossDSTAndHalfHourZone(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "usage.db"), testPricing(t, "1"))
	add := func(ts time.Time, model string, cost float64) {
		t.Helper()
		if err := store.Append(RequestRecord{TS: ts.UTC().Format(time.RFC3339), Provider: "openai", APIBase: "https://api.openai.com",
			Model: model, InputTokens: 10, OutputTokens: 1, CostCurrency: "USD", TotalCost: cost,
			CacheDetails: map[string]int64{"x": 1}}); err != nil {
			t.Fatal(err)
		}
	}

	newYork, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Skipf("zone data unavailable: %v", err)
	}
	kolkata, err := time.LoadLocation("Asia/Kolkata")
	if err != nil {
		t.Skipf("zone data unavailable: %v", err)
	}
	// DST starts in New York on 2026-03-08 at 02:00 local (07:00 UTC); that day is 23 hours.
	add(time.Date(2026, 3, 8, 4, 59, 0, 0, time.UTC), "a", 1)  // 2026-03-07 23:59 EST
	add(time.Date(2026, 3, 8, 5, 0, 0, 0, time.UTC), "a", 1)   // 2026-03-08 00:00 EST
	add(time.Date(2026, 3, 9, 3, 59, 0, 0, time.UTC), "b", 2)  // 2026-03-08 23:59 EDT
	add(time.Date(2026, 3, 9, 4, 0, 0, 0, time.UTC), "b", 2)   // 2026-03-09 00:00 EDT
	add(time.Date(2026, 3, 9, 18, 29, 0, 0, time.UTC), "a", 3) // 2026-03-09 23:59 IST
	add(time.Date(2026, 3, 9, 18, 30, 0, 0, time.UTC), "a", 3) // 2026-03-10 00:00 IST

	store.now = func() time.Time { return time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC) }
	cases := []struct {
		loc  *time.Location
		want map[string]int64
	}{
		{newYork, map[string]int64{"2026-03-07": 1, "2026-03-08": 2, "2026-03-09": 3, "2026-03-10": 0}},
		{kolkata, map[string]int64{"2026-03-07": 0, "2026-03-08": 2, "2026-03-09": 3, "2026-03-10": 1}},
		{time.UTC, map[string]int64{"2026-03-07": 0, "2026-03-08": 2, "2026-03-09": 4, "2026-03-10": 0}},
	}
	for _, tc := range cases {
		t.Run(tc.loc.String(), func(t *testing.T) {
			got, err := store.Daily(ctx, 4, tc.loc)
			if err != nil {
				t.Fatal(err)
			}
			if got.From != "2026-03-07" || got.To != "2026-03-10" || len(got.Days) != 4 || got.TimeZone != tc.loc.String() {
				t.Fatalf("range = %s..%s (%d days) %s", got.From, got.To, len(got.Days), got.TimeZone)
			}
			var sum int64
			for _, day := range got.Days {
				if day.Requests != tc.want[day.Date] {
					t.Fatalf("%s requests = %d, want %d", day.Date, day.Requests, tc.want[day.Date])
				}
				var byModel int64
				for _, m := range day.Models {
					byModel += m.Requests
				}
				if byModel != day.Requests || (day.Requests == 0 && day.Models != nil) {
					t.Fatalf("%s models = %+v", day.Date, day.Models)
				}
				if day.Requests > 0 && day.CacheDetails["x"] != day.Requests {
					t.Fatalf("%s cache details = %v", day.Date, day.CacheDetails)
				}
				sum += day.Requests
			}
			if got.Summary.Requests != sum {
				t.Fatalf("summary = %d, want %d", got.Summary.Requests, sum)
			}
			var modelSum int64
			for _, m := range got.Models {
				modelSum += m.Requests
			}
			if modelSum != sum {
				t.Fatalf("range models = %+v", got.Models)
			}
		})
	}
}

func TestUsageDailyClampsDays(t *testing.T) {
	store := openTestStore(t, filepath.Join(t.TempDir(), "usage.db"), testPricing(t, "1"))
	for _, tc := range []struct{ in, want int }{{0, DefaultDailyDays}, {-3, DefaultDailyDays}, {7, 7}, {5000, MaxDailyDays}} {
		got, err := store.Daily(context.Background(), tc.in, time.UTC)
		if err != nil {
			t.Fatalf("Daily(%d): %v", tc.in, err)
		}
		if len(got.Days) != tc.want {
			t.Fatalf("Daily(%d) days = %d, want %d", tc.in, len(got.Days), tc.want)
		}
	}
}

func TestUsageRetention(t *testing.T) {
	ctx := context.Background()
	store := openTestStore(t, filepath.Join(t.TempDir(), "usage.db"), testPricing(t, "1"))
	now := time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)
	store.now = func() time.Time { return now }
	for _, age := range []int{40, 31, 29, 1} {
		if err := store.Append(RequestRecord{TS: now.AddDate(0, 0, -age).Format(time.RFC3339), Model: "m", Provider: "p"}); err != nil {
			t.Fatal(err)
		}
	}
	store.SetRetentionDays(30)
	if err := store.Append(RequestRecord{TS: now.Format(time.RFC3339), Model: "m", Provider: "p"}); err != nil {
		t.Fatal(err)
	}
	records, err := store.Records(ctx, 0)
	if err != nil || len(records) != 3 {
		t.Fatalf("records = %d, %v; want 3", len(records), err)
	}
	// Within a day of the last purge, nothing more is deleted.
	if n, err := store.PurgeOlderThan(ctx, 1, false); err != nil || n != 0 {
		t.Fatalf("purge = %d, %v", n, err)
	}
}

func TestUsageSharedHandlesAndConcurrentWriters(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "usage.db")
	a := openTestStore(t, path, testPricing(t, "1"))
	b := openTestStore(t, path, testPricing(t, "1"))
	if a.DB() != b.DB() {
		t.Fatal("two handles on one path do not share the pool")
	}
	var wg sync.WaitGroup
	for _, store := range []*UsageStore{a, b} {
		wg.Add(1)
		go func(store *UsageStore) {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				if err := store.Append(RequestRecord{TS: time.Now().UTC().Format(time.RFC3339), Model: "m", Provider: "p"}); err != nil {
					t.Error(err)
					return
				}
			}
		}(store)
	}
	wg.Wait()
	_ = b.Close()
	records, err := a.Records(ctx, 0)
	if err != nil || len(records) != 100 {
		t.Fatalf("records = %d, %v", len(records), err)
	}
}

const usageWriterEnv = "MISTER_MORPH_TEST_USAGE_WRITER"

// TestUsageTwoProcessesWriting runs two copies of this test binary that each append rows to one
// usage.db at the same time; every row must arrive.
func TestUsageTwoProcessesWriting(t *testing.T) {
	if spec := os.Getenv(usageWriterEnv); spec != "" {
		parts := strings.SplitN(spec, "|", 3)
		n, _ := strconv.Atoi(parts[1])
		store, err := OpenUsageStore(context.Background(), parts[0], UsageStoreOptions{Pricing: testPricing(t, "1")})
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = store.Close() }()
		for i := 0; i < n; i++ {
			if err := store.Append(RequestRecord{TS: time.Now().UTC().Format(time.RFC3339), Model: parts[2], Provider: "p",
				Operation: "chat", InputTokens: 1_000_000}); err != nil {
				t.Fatal(err)
			}
		}
		return
	}
	path := filepath.Join(t.TempDir(), "usage.db")
	const perProcess = 200
	var cmds []*exec.Cmd
	for _, model := range []string{"test-model", "other"} {
		cmd := exec.Command(os.Args[0], "-test.run=^TestUsageTwoProcessesWriting$", "-test.count=1")
		cmd.Env = append(os.Environ(), fmt.Sprintf("%s=%s|%d|%s", usageWriterEnv, path, perProcess, model))
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		cmds = append(cmds, cmd)
	}
	for _, cmd := range cmds {
		if err := cmd.Wait(); err != nil {
			t.Fatalf("writer: %v", err)
		}
	}
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()
	var count, catalog int
	if err := db.QueryRow(`SELECT COUNT(*), COUNT(*) FILTER (WHERE cost_source = 'catalog') FROM llm_requests`).Scan(&count, &catalog); err != nil {
		t.Fatal(err)
	}
	if count != 2*perProcess || catalog != perProcess {
		t.Fatalf("rows = %d (catalog %d), want %d (%d)", count, catalog, 2*perProcess, perProcess)
	}
	if err := sqlitedb.IntegrityCheck(context.Background(), path); err != nil {
		t.Fatal(err)
	}
}
