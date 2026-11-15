package llmstats

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/stateimport"
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

// rowsQueryer is what the aggregate queries read through: the read transaction of one response.
type rowsQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// readSnapshot runs fn in one read-only transaction, so every query of a response sees the
// database as one moment left it: records appended meanwhile are in all of its totals or in none.
// A read-only transaction begins deferred, so it does not wait for, or block, the writers.
func (s *UsageStore) readSnapshot(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// queryTotals runs a GROUP BY over llm_requests and calls fn with each group's key columns
// (keys of them, scanned as text) and totals.
func queryTotals(ctx context.Context, db rowsQueryer, query string, keys int, args []any, fn func([]string, Totals)) error {
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
func queryCacheDetails(ctx context.Context, db rowsQueryer, query string, keys int, args []any, fn func([]string, string, int64)) error {
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
	byModel := map[string]*Totals{}
	type hostModel struct{ host, model string }
	byHostModel := map[hostModel]*Totals{}
	var rejectCount int
	if err := s.readSnapshot(ctx, func(tx *sql.Tx) error {
		if err := queryTotals(ctx, tx, `SELECT `+totalsColumns+` FROM llm_requests`, 0, nil, func(_ []string, t Totals) {
			out.Summary = t
		}); err != nil {
			return err
		}
		if err := queryTotals(ctx, tx, `SELECT model, `+totalsColumns+` FROM llm_requests GROUP BY model`, 1, nil, func(k []string, t Totals) {
			byModel[k[0]] = &t
		}); err != nil {
			return err
		}
		if err := queryTotals(ctx, tx, `SELECT api_host, model, `+totalsColumns+` FROM llm_requests GROUP BY api_host, model`, 2, nil, func(k []string, t Totals) {
			byHostModel[hostModel{k[0], k[1]}] = &t
		}); err != nil {
			return err
		}
		if err := queryCacheDetails(ctx, tx, `SELECT r.api_host, r.model, j.key, SUM(j.value) FROM llm_requests r, json_each(r.cache_details) j
			WHERE r.cache_details != '{}' GROUP BY r.api_host, r.model, j.key`, 2, nil, func(k []string, name string, sum int64) {
			addDetail(&out.Summary, name, sum)
			if t := byModel[k[1]]; t != nil {
				addDetail(t, name, sum)
			}
			if t := byHostModel[hostModel{k[0], k[1]}]; t != nil {
				addDetail(t, name, sum)
			}
		}); err != nil {
			return err
		}
		rejects, err := stateimport.Rejects(ctx, tx, usageImportStore)
		if err != nil {
			return err
		}
		rejectCount = rejects.Count
		return nil
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

	out.SkippedRecords = int64(rejectCount)
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

// Daily totals the last days calendar days in loc, today included, overall and per model, and the
// same apart for the agent's own calls and for coder runs (operation 'coder'); the combined
// totals are the sum of the two. Each
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

	// Rows by day, source (0 the agent, 1 a coder run) and model.
	const agent, coder = 0, 1
	var dayModels [2][]map[string]*Totals
	for source := range dayModels {
		dayModels[source] = make([]map[string]*Totals, days)
	}
	group := func(k []string) map[string]*Totals {
		i, source := atoiSafe(k[0]), atoiSafe(k[1])
		if i < 0 || i >= days || source < agent || source > coder {
			return nil
		}
		if dayModels[source][i] == nil {
			dayModels[source][i] = map[string]*Totals{}
		}
		return dayModels[source][i]
	}
	if err := s.readSnapshot(ctx, func(tx *sql.Tx) error {
		if err := queryTotals(ctx, tx, with+`SELECT days.i, (r.operation = 'coder'), r.model, `+totalsColumns+join+
			`GROUP BY days.i, (r.operation = 'coder'), r.model`, 3, args, func(k []string, t Totals) {
			if models := group(k); models != nil {
				copyT := t
				models[k[2]] = &copyT
			}
		}); err != nil {
			return err
		}
		return queryCacheDetails(ctx, tx, with+`SELECT days.i, (r.operation = 'coder'), r.model, j.key, SUM(j.value)`+join+`, json_each(r.cache_details) j
			WHERE r.cache_details != '{}' GROUP BY days.i, (r.operation = 'coder'), r.model, j.key`, 3, args, func(k []string, name string, sum int64) {
			if models := group(k); models != nil {
				if t := models[k[2]]; t != nil {
					addDetail(t, name, sum)
				}
			}
		})
	}); err != nil {
		return DailyUsage{}, err
	}
	rangeModels := map[string]*Totals{}
	var sourceRangeModels [2]map[string]*Totals
	addModel := func(byModel map[string]*Totals, model string, t Totals) {
		total := byModel[model]
		if total == nil {
			total = &Totals{}
			byModel[model] = total
		}
		total.addTotals(t)
	}
	for i := range days {
		combined := map[string]*Totals{}
		for source := range dayModels {
			daySource, rangeSource := &out.Days[i].Sources.Agent, &out.Sources.Agent
			if source == coder {
				daySource, rangeSource = &out.Days[i].Sources.Coder, &out.Sources.Coder
			}
			if sourceRangeModels[source] == nil {
				sourceRangeModels[source] = map[string]*Totals{}
			}
			for model, t := range dayModels[source][i] {
				daySource.Totals.addTotals(*t)
				rangeSource.Summary.addTotals(*t)
				out.Days[i].Totals.addTotals(*t)
				out.Summary.addTotals(*t)
				addModel(combined, model, *t)
				addModel(rangeModels, model, *t)
				addModel(sourceRangeModels[source], model, *t)
			}
			daySource.Models = sourceModelSummaries(dayModels[source][i])
		}
		out.Days[i].Models = modelSummaries(combined)
	}
	out.Models = modelSummaries(rangeModels)
	out.Sources.Agent.Models = sourceModelSummaries(sourceRangeModels[agent])
	out.Sources.Coder.Models = sourceModelSummaries(sourceRangeModels[coder])
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
		evaluation, pricing_parts FROM llm_requests ORDER BY id`
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
		var parts string
		if err := rows.Scan(&ts, &rec.RunID, &rec.OriginEventID, &rec.Provider, &rec.APIBase, &rec.APIHost, &rec.Model,
			&rec.Operation, &rec.Scene, &rec.InputTokens, &rec.OutputTokens, &rec.TotalTokens, &rec.CachedInputTokens,
			&rec.CacheCreationInputTokens, &details, &rec.CostCurrency, &estimated, &rec.InputCost, &rec.CachedInputCost,
			&rec.CacheCreationInputCost, &rec.OutputCost, &rec.TotalCost, &rec.DurationMs, &evaluation, &parts); err != nil {
			return nil, err
		}
		rec.TS = time.UnixMilli(ts).UTC().Format(time.RFC3339Nano)
		rec.CostEstimated = estimated != 0
		if details != "" && details != "{}" {
			_ = json.Unmarshal([]byte(details), &rec.CacheDetails)
		}
		rec.PricingParts = decodePricingParts(parts)
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
