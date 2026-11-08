package llmstats

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

// totalsColumns aggregates llm_requests into the columns scanTotals reads.
const totalsColumns = `COUNT(*), COALESCE(SUM(input_tokens), 0), COALESCE(SUM(output_tokens), 0),
	COALESCE(SUM(total_tokens), 0), COALESCE(SUM(cached_input_tokens), 0), COALESCE(SUM(cache_creation_input_tokens), 0),
	COUNT(DISTINCT NULLIF(cost_currency, '')), COALESCE(MAX(cost_currency), ''), COALESCE(MAX(cost_estimated), 0),
	COALESCE(SUM(input_cost), 0), COALESCE(SUM(cached_input_cost), 0), COALESCE(SUM(cache_creation_input_cost), 0),
	COALESCE(SUM(output_cost), 0), COALESCE(SUM(total_cost), 0)`

func totalsDest(t *Totals, currencies *int, currency *string, estimated *int) []any {
	return []any{&t.Requests, &t.InputTokens, &t.OutputTokens, &t.TotalTokens, &t.CachedInputTokens,
		&t.CacheCreationInputTokens, currencies, currency, estimated, &t.InputCost, &t.CachedInputCost,
		&t.CacheCreationInputCost, &t.OutputCost, &t.TotalCost}
}

func finishTotals(t *Totals, currencies int, currency string, estimated int) {
	switch {
	case currencies == 0:
		t.CostCurrency = ""
	case currencies == 1:
		t.CostCurrency = currency
	default:
		t.CostCurrency = "MIXED"
	}
	t.CostEstimated = estimated != 0
}

// queryTotals runs a GROUP BY over llm_requests and calls fn with each group's key columns
// (keys of them, scanned as text) and totals.
func queryTotals(ctx context.Context, db *sql.DB, query string, keys int, args []any, fn func([]string, Totals)) error {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		keyValues := make([]string, keys)
		dest := make([]any, 0, keys+14)
		for i := range keyValues {
			dest = append(dest, &keyValues[i])
		}
		var t Totals
		var currencies, estimated int
		var currency string
		dest = append(dest, totalsDest(&t, &currencies, &currency, &estimated)...)
		if err := rows.Scan(dest...); err != nil {
			return err
		}
		finishTotals(&t, currencies, currency, estimated)
		fn(keyValues, t)
	}
	return rows.Err()
}

// queryCacheDetails sums cache_details per group and calls fn with each group's keys, detail
// name and sum.
func queryCacheDetails(ctx context.Context, db *sql.DB, query string, keys int, args []any, fn func([]string, string, int64)) error {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		keyValues := make([]string, keys)
		dest := make([]any, 0, keys+2)
		for i := range keyValues {
			dest = append(dest, &keyValues[i])
		}
		var name string
		var sum int64
		dest = append(dest, &name, &sum)
		if err := rows.Scan(dest...); err != nil {
			return err
		}
		fn(keyValues, name, sum)
	}
	return rows.Err()
}

func addDetail(t *Totals, name string, value int64) {
	if t.CacheDetails == nil {
		t.CacheDetails = map[string]int64{}
	}
	t.CacheDetails[name] += value
}

// Usage totals every recorded call: overall, by model, and by API host and model.
func (s *UsageStore) Usage(ctx context.Context) (Projection, error) {
	if s == nil || s.db == nil {
		return Projection{}, fmt.Errorf("usage store is not open")
	}
	var out Projection
	if err := queryTotals(ctx, s.db, `SELECT `+totalsColumns+` FROM llm_requests`, 0, nil, func(_ []string, t Totals) {
		out.Summary = t
	}); err != nil {
		return Projection{}, err
	}
	byModel := map[string]*Totals{}
	if err := queryTotals(ctx, s.db, `SELECT model, `+totalsColumns+` FROM llm_requests GROUP BY model`, 1, nil, func(k []string, t Totals) {
		byModel[k[0]] = &t
	}); err != nil {
		return Projection{}, err
	}
	type hostModel struct{ host, model string }
	byHostModel := map[hostModel]*Totals{}
	if err := queryTotals(ctx, s.db, `SELECT api_host, model, `+totalsColumns+` FROM llm_requests GROUP BY api_host, model`, 2, nil, func(k []string, t Totals) {
		byHostModel[hostModel{k[0], k[1]}] = &t
	}); err != nil {
		return Projection{}, err
	}
	if err := queryCacheDetails(ctx, s.db, `SELECT r.api_host, r.model, j.key, SUM(j.value) FROM llm_requests r, json_each(r.cache_details) j
		WHERE r.cache_details != '{}' GROUP BY r.api_host, r.model, j.key`, 2, nil, func(k []string, name string, sum int64) {
		addDetail(&out.Summary, name, sum)
		if t := byModel[k[1]]; t != nil {
			addDetail(t, name, sum)
		}
		if t := byHostModel[hostModel{k[0], k[1]}]; t != nil {
			addDetail(t, name, sum)
		}
	}); err != nil {
		return Projection{}, err
	}

	out.Models = make([]ModelSummary, 0, len(byModel))
	for model, t := range byModel {
		out.Models = append(out.Models, ModelSummary{Model: model, Totals: *t})
	}
	sortModelSummaries(out.Models)
	hosts := map[string]*APIHostSummary{}
	for key, t := range byHostModel {
		host := hosts[key.host]
		if host == nil {
			host = &APIHostSummary{APIHost: key.host}
			hosts[key.host] = host
		}
		host.Totals.addTotals(*t)
		host.Models = append(host.Models, ModelSummary{Model: key.model, Totals: *t})
	}
	out.APIHosts = make([]APIHostSummary, 0, len(hosts))
	for _, host := range hosts {
		out.APIHosts = append(out.APIHosts, *host)
	}
	sortAPIHostSummaries(out.APIHosts)

	rejects, err := s.ImportRejects(ctx)
	if err != nil {
		return Projection{}, err
	}
	out.SkippedRecords = int64(rejects.Count)
	out.ProjectedRecords = out.Summary.Requests
	out.UpdatedAt = s.now().UTC().Format(time.RFC3339)
	return out, nil
}

// addTotals adds o into t, as adding o's records one by one would.
func (t *Totals) addTotals(o Totals) {
	t.Requests += o.Requests
	t.InputTokens += o.InputTokens
	t.OutputTokens += o.OutputTokens
	t.TotalTokens += o.TotalTokens
	t.CachedInputTokens += o.CachedInputTokens
	t.CacheCreationInputTokens += o.CacheCreationInputTokens
	t.CostCurrency = mergeCostCurrency(t.CostCurrency, o.CostCurrency)
	t.CostEstimated = t.CostEstimated || o.CostEstimated
	t.InputCost += o.InputCost
	t.CachedInputCost += o.CachedInputCost
	t.CacheCreationInputCost += o.CacheCreationInputCost
	t.OutputCost += o.OutputCost
	t.TotalCost += o.TotalCost
	for key, value := range o.CacheDetails {
		addDetail(t, key, value)
	}
}

// Daily totals the last days calendar days in loc, today included, overall and per model. Each
// local day's start and end are computed in loc, so days across a DST change are 23 or 25 hours
// long and half-hour offsets fall where they should; one query joins those ranges to the rows.
func (s *UsageStore) Daily(ctx context.Context, days int, loc *time.Location) (DailyUsage, error) {
	if s == nil || s.db == nil {
		return DailyUsage{}, fmt.Errorf("usage store is not open")
	}
	if days <= 0 {
		days = DefaultDailyDays
	}
	if days > MaxDailyDays {
		days = MaxDailyDays
	}
	if loc == nil {
		loc = time.UTC
	}
	today := s.now().In(loc)
	firstDay := time.Date(today.Year(), today.Month(), today.Day()-(days-1), 0, 0, 0, 0, loc)

	out := DailyUsage{TimeZone: loc.String(), Days: make([]DaySummary, days)}
	var values strings.Builder
	args := make([]any, 0, days*3)
	for i := range days {
		start := time.Date(firstDay.Year(), firstDay.Month(), firstDay.Day()+i, 0, 0, 0, 0, loc)
		end := time.Date(firstDay.Year(), firstDay.Month(), firstDay.Day()+i+1, 0, 0, 0, 0, loc)
		out.Days[i].Date = start.Format(time.DateOnly)
		if i > 0 {
			values.WriteString(", ")
		}
		values.WriteString("(?, ?, ?)")
		args = append(args, i, start.UnixMilli(), end.UnixMilli())
	}
	out.From = out.Days[0].Date
	out.To = out.Days[days-1].Date
	with := `WITH days (i, start_ms, end_ms) AS (VALUES ` + values.String() + `) `
	// The days table's columns do not clash with llm_requests', so the aggregates need no prefix.
	join := ` FROM days JOIN llm_requests r ON r.ts >= days.start_ms AND r.ts < days.end_ms `

	dayModels := make([]map[string]*Totals, days)
	rangeModels := map[string]*Totals{}
	if err := queryTotals(ctx, s.db, with+`SELECT days.i, r.model, `+totalsColumns+join+`GROUP BY days.i, r.model`, 2, args, func(k []string, t Totals) {
		i := atoiSafe(k[0])
		if i < 0 || i >= days {
			return
		}
		if dayModels[i] == nil {
			dayModels[i] = map[string]*Totals{}
		}
		copyT := t
		dayModels[i][k[1]] = &copyT
	}); err != nil {
		return DailyUsage{}, err
	}
	if err := queryCacheDetails(ctx, s.db, with+`SELECT days.i, r.model, j.key, SUM(j.value)`+join+`, json_each(r.cache_details) j
		WHERE r.cache_details != '{}' GROUP BY days.i, r.model, j.key`, 2, args, func(k []string, name string, sum int64) {
		i := atoiSafe(k[0])
		if i < 0 || i >= days || dayModels[i] == nil {
			return
		}
		if t := dayModels[i][k[1]]; t != nil {
			addDetail(t, name, sum)
		}
	}); err != nil {
		return DailyUsage{}, err
	}
	for i, models := range dayModels {
		for model, t := range models {
			out.Days[i].Totals.addTotals(*t)
			out.Summary.addTotals(*t)
			total := rangeModels[model]
			if total == nil {
				total = &Totals{}
				rangeModels[model] = total
			}
			total.addTotals(*t)
		}
		out.Days[i].Models = modelSummaries(models)
	}
	out.Models = modelSummaries(rangeModels)
	return out, nil
}

func atoiSafe(raw string) int {
	n := 0
	for _, r := range raw {
		if r < '0' || r > '9' {
			return -1
		}
		n = n*10 + int(r-'0')
	}
	return n
}

// Records lists recorded calls oldest first, up to limit (all when limit <= 0).
func (s *UsageStore) Records(ctx context.Context, limit int) ([]RequestRecord, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("usage store is not open")
	}
	query := `SELECT ts, run_id, origin_event_id, provider, api_base, api_host, model, operation, scene, input_tokens,
		output_tokens, total_tokens, cached_input_tokens, cache_creation_input_tokens, cache_details, cost_currency,
		cost_estimated, input_cost, cached_input_cost, cache_creation_input_cost, output_cost, total_cost, duration_ms,
		evaluation FROM llm_requests ORDER BY id`
	var args []any
	if limit > 0 {
		query += ` LIMIT ?`
		args = append(args, limit)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []RequestRecord
	for rows.Next() {
		var rec RequestRecord
		var ts int64
		var details string
		var estimated int
		var evaluation sql.NullString
		if err := rows.Scan(&ts, &rec.RunID, &rec.OriginEventID, &rec.Provider, &rec.APIBase, &rec.APIHost, &rec.Model,
			&rec.Operation, &rec.Scene, &rec.InputTokens, &rec.OutputTokens, &rec.TotalTokens, &rec.CachedInputTokens,
			&rec.CacheCreationInputTokens, &details, &rec.CostCurrency, &estimated, &rec.InputCost, &rec.CachedInputCost,
			&rec.CacheCreationInputCost, &rec.OutputCost, &rec.TotalCost, &rec.DurationMs, &evaluation); err != nil {
			return nil, err
		}
		rec.TS = time.UnixMilli(ts).UTC().Format(time.RFC3339Nano)
		rec.CostEstimated = estimated != 0
		if details != "" && details != "{}" {
			_ = json.Unmarshal([]byte(details), &rec.CacheDetails)
		}
		if evaluation.Valid && evaluation.String != "" {
			rec.Evaluation = &EvaluationRecord{}
			if err := json.Unmarshal([]byte(evaluation.String), rec.Evaluation); err != nil {
				return nil, err
			}
		}
		out = append(out, rec)
	}
	return out, rows.Err()
}

// ReadUsageRecords opens usage.db at path and lists its records, oldest first.
func ReadUsageRecords(ctx context.Context, path string) ([]RequestRecord, error) {
	store, err := OpenUsageStore(ctx, path, UsageStoreOptions{})
	if err != nil {
		return nil, err
	}
	defer func() { _ = store.Close() }()
	return store.Records(ctx, 0)
}
