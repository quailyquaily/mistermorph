package llmstats

import (
	"context"
	"math"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	uniaiapi "github.com/quailyquaily/uniai"
)

// tieredPricing is a catalog whose model costs ten times as much for a request of more than
// 100,000 input tokens, and whose 1-hour cache writes cost more than the others. scale multiplies
// every rate, as a later catalog would.
func tieredPricing(t *testing.T, digest string, scale float64) PricingSource {
	t.Helper()
	limit := 100_000
	rates := func(by float64) uniaiapi.ChatPricingTier {
		cached, write := 0.1*by*scale, 1.25*by*scale
		return uniaiapi.ChatPricingTier{
			InputUSDPerMillion: 1 * by * scale, OutputUSDPerMillion: 5 * by * scale,
			CachedInputUSDPerMillion: &cached, CacheCreationInputUSDPerMillion: &write,
			CacheCreationInputDetailUSDPerMillion: map[string]float64{"ephemeral_1h_input_tokens": 2 * by * scale},
		}
	}
	low, high := rates(1), rates(10)
	low.MaxInputTokens = &limit
	catalog := &uniaiapi.PricingCatalog{Chat: []uniaiapi.ChatPricingRule{
		{Model: "tier-model", Tiers: []uniaiapi.ChatPricingTier{low, high}},
	}}
	return func() (*uniaiapi.PricingCatalog, string, error) { return catalog, digest, nil }
}

func coderRecord(model string) RequestRecord {
	return RequestRecord{
		TS: time.Now().UTC().Format(time.RFC3339), Provider: "claude-code", APIHost: "claude-code",
		Model: model, Operation: OperationCoder, Scene: OperationCoder,
	}
}

type costRow struct {
	Input, Cached, Write, Output, Total float64
	Source                              string
	Estimated                           bool
}

func costRows(t *testing.T, store *UsageStore) []costRow {
	t.Helper()
	rows, err := store.DB().QueryContext(context.Background(), `SELECT input_cost, cached_input_cost, cache_creation_input_cost,
		output_cost, total_cost, cost_source, cost_estimated FROM llm_requests ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	var out []costRow
	for rows.Next() {
		var r costRow
		if err := rows.Scan(&r.Input, &r.Cached, &r.Write, &r.Output, &r.Total, &r.Source, &r.Estimated); err != nil {
			t.Fatal(err)
		}
		out = append(out, r)
	}
	return out
}

func sameCost(a, b float64) bool { return math.Abs(a-b) < 1e-9 }

func checkCosts(t *testing.T, when string, got []costRow, want []costRow) {
	t.Helper()
	if len(got) != len(want) {
		t.Fatalf("%s: rows = %+v\nwant %+v", when, got, want)
	}
	for i := range want {
		g, w := got[i], want[i]
		if !sameCost(g.Input, w.Input) || !sameCost(g.Cached, w.Cached) || !sameCost(g.Write, w.Write) ||
			!sameCost(g.Output, w.Output) || !sameCost(g.Total, w.Total) || g.Source != w.Source || g.Estimated != w.Estimated {
			t.Fatalf("%s: row %d = %+v\nwant %+v", when, i, g, w)
		}
	}
}

// The catalog's own numbers: three claude-haiku-5-5 responses of 50,000 input tokens (48,000 of
// them cached) and 1,000 output tokens cost $0.001180 each, $0.003540 together. Their sum is
// 150,000 input tokens, which no request had; priced as one request it would be $0.017700.
func TestUsagePricesACoderRowByItsRequestsWithTheDefaultCatalog(t *testing.T) {
	store := openTestStore(t, filepath.Join(t.TempDir(), "usage.db"), DefaultPricing)
	part := PricingPart{InputTokens: 50_000, CachedInputTokens: 48_000, OutputTokens: 1000}
	sum := coderRecord("claude-haiku-5-5")
	sum.InputTokens, sum.CachedInputTokens, sum.OutputTokens = 150_000, 144_000, 3000
	one := coderRecord("claude-haiku-5-5")
	one.InputTokens, one.CachedInputTokens, one.OutputTokens = 50_000, 48_000, 1000
	parts := sum
	parts.PricingParts = []PricingPart{part, part, part}
	counted := sum
	counted.PricingParts = []PricingPart{{InputTokens: 50_000, CachedInputTokens: 48_000, OutputTokens: 1000, Count: 3}}
	for _, rec := range []RequestRecord{one, parts, counted, sum} {
		if err := store.Append(rec); err != nil {
			t.Fatal(err)
		}
	}
	got := costRows(t, store)
	if len(got) != 4 {
		t.Fatalf("rows = %+v", got)
	}
	single := got[0].Total
	if !sameCost(single, 0.001180) {
		t.Fatalf("one response = %v, want 0.001180", single)
	}
	for i, row := range got[1:3] {
		if !sameCost(row.Total, 3*single) || !sameCost(row.Input, 3*got[0].Input) || !sameCost(row.Cached, 3*got[0].Cached) ||
			!sameCost(row.Output, 3*got[0].Output) || row.Source != costSourceCatalog || !row.Estimated {
			t.Fatalf("row %d of three responses = %+v, want three times %+v", i+1, row, got[0])
		}
		if !sameCost(row.Total, 0.003540) {
			t.Fatalf("row %d of three responses = %v, want 0.003540", i+1, row.Total)
		}
	}
	// What the fix is about: the same tokens as one request are in another tier.
	if !sameCost(got[3].Total, 0.017700) {
		t.Fatalf("the sum as one request = %v, want 0.017700", got[3].Total)
	}
}

// A row of several requests is priced request by request when it is written, when the catalog
// changes, and after the database was closed and opened again.
func TestUsagePricesAndRepricesACoderRowByItsRequests(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "usage.db")
	store := openTestStore(t, path, tieredPricing(t, "tiers-1", 1))

	// Three requests of 50,000 input tokens (48,000 cached, 1,000 written to the 1-hour cache)
	// and 1,000 output tokens: each in the low tier, their sum in the high one.
	part := PricingPart{InputTokens: 50_000, CachedInputTokens: 48_000, CacheCreationInputTokens: 1000, OutputTokens: 1000,
		CacheDetails: map[string]int64{"ephemeral_1h_input_tokens": 1000}}
	byRequest := coderRecord("tier-model")
	byRequest.InputTokens, byRequest.CachedInputTokens, byRequest.CacheCreationInputTokens, byRequest.OutputTokens = 150_000, 144_000, 3000, 3000
	byRequest.CacheDetails = map[string]int64{"ephemeral_1h_input_tokens": 3000}
	byRequest.PricingParts = []PricingPart{part, part, part}
	asOne := byRequest
	asOne.PricingParts = nil
	// A request of 200,000 input tokens in the high tier, beside a small one in the low tier.
	mixed := coderRecord("tier-model")
	mixed.InputTokens, mixed.OutputTokens = 201_000, 300
	mixed.PricingParts = []PricingPart{{InputTokens: 200_000, OutputTokens: 100}, {InputTokens: 1000, OutputTokens: 200}}
	// A later task corrects a response an earlier one reported: 4 output tokens became 60.
	corrected := coderRecord("tier-model")
	corrected.InputTokens, corrected.OutputTokens = 3000, 1056
	corrected.PricingParts = []PricingPart{
		{InputTokens: 120_000, OutputTokens: 4, Count: -1},
		{InputTokens: 120_000, OutputTokens: 60},
		{InputTokens: 3000, OutputTokens: 1000},
	}
	// A model the catalog does not know stays without a cost, parts or not.
	unknown := coderRecord("unknown-model")
	unknown.InputTokens, unknown.OutputTokens = 100_000, 2000
	unknown.PricingParts = []PricingPart{part, part}
	// The CLI's own cost is left alone, parts or not.
	provider := byRequest
	provider.CostCurrency, provider.CostEstimated, provider.TotalCost = "USD", true, 7
	for _, rec := range []RequestRecord{byRequest, asOne, mixed, corrected, unknown, provider} {
		if err := store.Append(rec); err != nil {
			t.Fatal(err)
		}
	}
	want := func(scale float64) []costRow {
		return []costRow{
			// 3 x (1,000 in at $1, 48,000 cached at $0.10, 1,000 written at $2, 1,000 out at $5) per 1M.
			{Input: scale * 0.003, Cached: scale * 0.0144, Write: scale * 0.006, Output: scale * 0.015, Total: scale * 0.0384, Source: "catalog", Estimated: true},
			// The same tokens as one request: all of it in the high tier.
			{Input: scale * 0.03, Cached: scale * 0.144, Write: scale * 0.06, Output: scale * 0.15, Total: scale * 0.384, Source: "catalog", Estimated: true},
			// 200,000 in at $10 and 100 out at $50; 1,000 in at $1 and 200 out at $5.
			{Input: scale * 2.001, Output: scale * 0.006, Total: scale * 2.007, Source: "catalog", Estimated: true},
			// 56 more output tokens at the high tier's $50, and the small request.
			{Input: scale * 0.003, Output: scale * (0.0028 + 0.005), Total: scale * 0.0108, Source: "catalog", Estimated: true},
			{},
			{Total: 7, Source: "provider", Estimated: true},
		}
	}
	checkCosts(t, "written", costRows(t, store), want(1))

	// The parts are kept as they were given.
	records, err := store.Records(ctx, 0)
	if err != nil || len(records) != 6 {
		t.Fatalf("records = %+v, %v", records, err)
	}
	if !reflect.DeepEqual(records[0].PricingParts, []PricingPart{part, part, part}) || records[1].PricingParts != nil ||
		!reflect.DeepEqual(records[3].PricingParts, corrected.PricingParts) {
		t.Fatalf("parts = %+v, %+v, %+v", records[0].PricingParts, records[1].PricingParts, records[3].PricingParts)
	}
	// The rows' own numbers, which the pages add up, are the sums as before.
	usage, err := store.Usage(ctx)
	if err != nil || usage.Summary.Requests != 6 || usage.Summary.InputTokens != 3*150_000+201_000+3000+100_000 {
		t.Fatalf("summary = %+v, %v", usage.Summary, err)
	}

	// A catalog with other prices: each row is priced again by its requests.
	catalog, digest, _ := tieredPricing(t, "tiers-3", 3)()
	if err := store.SetPricing(ctx, catalog, digest); err != nil {
		t.Fatal(err)
	}
	checkCosts(t, "repriced", costRows(t, store), want(3))

	// And once more by a store that opens the file anew.
	_ = store.Close()
	store = openTestStore(t, path, tieredPricing(t, "tiers-1", 1))
	checkCosts(t, "reopened", costRows(t, store), want(1))
}

// Cache writes cost by their lifetime. The catalog's own numbers: 1,000,000 cache-write tokens of
// claude-sonnet-5-5 are $2.50 at the 5-minute price, the default, and $4.00 for the 1-hour cache.
func TestUsagePricesCoderCacheWritesByLifetime(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "usage.db")
	store := openTestStore(t, path, DefaultPricing)
	rec := func(details map[string]int64, parts ...PricingPart) RequestRecord {
		r := coderRecord("claude-sonnet-5-5")
		r.InputTokens, r.CacheCreationInputTokens, r.CacheDetails, r.PricingParts = 1_000_000, 1_000_000, details, parts
		return r
	}
	hour := map[string]int64{"ephemeral_1h_input_tokens": 1_000_000}
	minutes := map[string]int64{"ephemeral_5m_input_tokens": 1_000_000}
	half := func(key string) PricingPart {
		return PricingPart{InputTokens: 500_000, CacheCreationInputTokens: 500_000, CacheDetails: map[string]int64{key: 500_000}}
	}
	for _, r := range []RequestRecord{
		rec(nil), rec(minutes), rec(hour),
		// Two requests, one of each lifetime: the row's split, and each part's.
		rec(map[string]int64{"ephemeral_1h_input_tokens": 500_000, "ephemeral_5m_input_tokens": 500_000},
			half("ephemeral_1h_input_tokens"), half("ephemeral_5m_input_tokens")),
	} {
		if err := store.Append(r); err != nil {
			t.Fatal(err)
		}
	}
	check := func(when string) {
		t.Helper()
		got := costRows(t, store)
		if len(got) != 4 {
			t.Fatalf("%s: rows = %+v", when, got)
		}
		for i, want := range []float64{2.50, 2.50, 4.00, 3.25} {
			if !sameCost(got[i].Write, want) || !sameCost(got[i].Total, want) {
				t.Fatalf("%s: row %d = %+v, want %v", when, i, got[i], want)
			}
		}
	}
	check("written")
	// Priced again from what the rows keep: the split survives.
	catalog, _, _ := DefaultPricing()
	if err := store.SetPricing(ctx, catalog, "another digest"); err != nil {
		t.Fatal(err)
	}
	check("repriced")
	daily, err := store.Daily(ctx, 1, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if got := daily.Summary.CacheDetails; got["ephemeral_1h_input_tokens"] != 1_500_000 || got["ephemeral_5m_input_tokens"] != 1_500_000 {
		t.Fatalf("daily cache details = %+v", got)
	}
}

// A usage.db of a build before the column: it is added when the file opens, and the rows there
// are priced by their own numbers as before.
func TestUsageAddsThePricingPartsColumn(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "usage.db")
	store := openTestStore(t, path, tieredPricing(t, "tiers-1", 1))
	old := coderRecord("tier-model")
	old.InputTokens = 50_000
	if err := store.Append(old); err != nil {
		t.Fatal(err)
	}
	if _, err := store.DB().ExecContext(ctx, `ALTER TABLE llm_requests DROP COLUMN pricing_parts`); err != nil {
		t.Fatal(err)
	}
	_ = store.Close()

	store = openTestStore(t, path, tieredPricing(t, "tiers-2", 2))
	rec := coderRecord("tier-model")
	rec.InputTokens = 150_000
	rec.PricingParts = []PricingPart{{InputTokens: 75_000}, {InputTokens: 75_000}}
	if err := store.Append(rec); err != nil {
		t.Fatal(err)
	}
	checkCosts(t, "after the column was added", costRows(t, store), []costRow{
		{Input: 0.1, Total: 0.1, Source: "catalog", Estimated: true},
		{Input: 0.3, Total: 0.3, Source: "catalog", Estimated: true},
	})
	// Opening again finds the column there.
	_ = store.Close()
	store = openTestStore(t, path, tieredPricing(t, "tiers-2", 2))
	if records, err := store.Records(ctx, 0); err != nil || len(records) != 2 || len(records[1].PricingParts) != 2 {
		t.Fatalf("records = %+v, %v", records, err)
	}
}

// A usage.db that holds rows of Claude Code's terminal sessions, written before its stream
// sessions: they carry no cost of the CLI's but their requests (one of them a correction of an
// earlier task's, Count -1). Nothing writes such rows for Claude Code any more, and they are
// still priced again, request by request, when a later build opens the file with another
// catalog. A stream session's row beside them keeps the CLI's own cost.
func TestUsageRepricesTerminalRowsAlreadyInAFile(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "usage.db")
	store := openTestStore(t, path, tieredPricing(t, "tiers-1", 1))
	part := PricingPart{InputTokens: 50_000, CachedInputTokens: 48_000, CacheCreationInputTokens: 1000, OutputTokens: 1000,
		CacheDetails: map[string]int64{"ephemeral_1h_input_tokens": 1000}}
	terminal := coderRecord("tier-model")
	terminal.InputTokens, terminal.CachedInputTokens, terminal.CacheCreationInputTokens, terminal.OutputTokens = 150_000, 144_000, 3000, 3000
	terminal.CacheDetails = map[string]int64{"ephemeral_1h_input_tokens": 3000}
	terminal.PricingParts = []PricingPart{part, part, part}
	corrected := coderRecord("tier-model")
	corrected.InputTokens, corrected.OutputTokens = 3000, 1056
	corrected.PricingParts = []PricingPart{
		{InputTokens: 120_000, OutputTokens: 4, Count: -1},
		{InputTokens: 120_000, OutputTokens: 60},
		{InputTokens: 3000, OutputTokens: 1000},
	}
	for _, rec := range []RequestRecord{terminal, corrected} {
		if err := store.Append(rec); err != nil {
			t.Fatal(err)
		}
	}
	legacy := func(scale float64) []costRow {
		return []costRow{
			{Input: scale * 0.003, Cached: scale * 0.0144, Write: scale * 0.006, Output: scale * 0.015, Total: scale * 0.0384, Source: "catalog", Estimated: true},
			{Input: scale * 0.003, Output: scale * (0.0028 + 0.005), Total: scale * 0.0108, Source: "catalog", Estimated: true},
		}
	}
	checkCosts(t, "written", costRows(t, store), legacy(1))
	_ = store.Close()

	// The file as a later build finds it: the parts are in their column, the catalog is another.
	store = openTestStore(t, path, tieredPricing(t, "tiers-4", 4))
	records, err := store.Records(ctx, 0)
	if err != nil || len(records) != 2 || !reflect.DeepEqual(records[0].PricingParts, terminal.PricingParts) ||
		!reflect.DeepEqual(records[1].PricingParts, corrected.PricingParts) {
		t.Fatalf("records = %+v, %v", records, err)
	}
	checkCosts(t, "opened with another catalog", costRows(t, store), legacy(4))

	// A stream session's row: the CLI's list price, no parts.
	session := coderRecord("tier-model")
	session.InputTokens, session.CachedInputTokens, session.OutputTokens = 150_000, 144_000, 3000
	session.CostCurrency, session.CostEstimated, session.TotalCost = "USD", true, 0.42
	if err := store.Append(session); err != nil {
		t.Fatal(err)
	}
	catalog, digest, _ := tieredPricing(t, "tiers-2", 2)()
	if err := store.SetPricing(ctx, catalog, digest); err != nil {
		t.Fatal(err)
	}
	checkCosts(t, "repriced beside a session's row", costRows(t, store),
		append(legacy(2), costRow{Total: 0.42, Source: "provider", Estimated: true}))
}
