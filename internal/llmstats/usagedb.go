package llmstats

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	uniaiapi "github.com/quailyquaily/uniai"
)

const usageSchemaSQL = `
CREATE TABLE llm_requests (
	id                          INTEGER PRIMARY KEY,
	ts                          INTEGER NOT NULL,
	run_id                      TEXT NOT NULL DEFAULT '',
	origin_event_id             TEXT NOT NULL DEFAULT '',
	provider                    TEXT NOT NULL,
	api_base                    TEXT NOT NULL DEFAULT '',
	api_host                    TEXT NOT NULL,
	model                       TEXT NOT NULL,
	operation                   TEXT NOT NULL DEFAULT '',
	scene                       TEXT NOT NULL DEFAULT '',
	input_tokens                INTEGER NOT NULL DEFAULT 0,
	output_tokens               INTEGER NOT NULL DEFAULT 0,
	total_tokens                INTEGER NOT NULL DEFAULT 0,
	cached_input_tokens         INTEGER NOT NULL DEFAULT 0,
	cache_creation_input_tokens INTEGER NOT NULL DEFAULT 0,
	cache_details               TEXT NOT NULL DEFAULT '{}',
	cost_currency               TEXT NOT NULL DEFAULT '',
	cost_estimated              INTEGER NOT NULL DEFAULT 0 CHECK (cost_estimated IN (0, 1)),
	cost_source                 TEXT NOT NULL DEFAULT '',
	input_cost                  REAL NOT NULL DEFAULT 0,
	cached_input_cost           REAL NOT NULL DEFAULT 0,
	cache_creation_input_cost   REAL NOT NULL DEFAULT 0,
	output_cost                 REAL NOT NULL DEFAULT 0,
	total_cost                  REAL NOT NULL DEFAULT 0,
	duration_ms                 INTEGER NOT NULL DEFAULT 0,
	evaluation                  TEXT
);
CREATE INDEX llm_requests_by_ts ON llm_requests (ts);
CREATE INDEX llm_requests_by_model ON llm_requests (model, ts);
CREATE INDEX llm_requests_by_host ON llm_requests (api_host, model);
CREATE INDEX llm_requests_catalog_priced ON llm_requests (cost_source) WHERE cost_source = 'catalog';
`

const (
	// usageImportStore names the JSONL import in meta.
	usageImportStore  = "llm_usage"
	metaPricingDigest = "pricing_digest"
	metaRetentionRun  = "retention_purged_at"

	costSourceProvider = "provider"
	costSourceCatalog  = "catalog"

	repriceBatch = 500
)

// LegacyUsageJournalDir is where the JSONL usage journal was, relative to the state folder.
var LegacyUsageJournalDir = filepath.Join("stats", "llm_usage")

// LegacyUsageProjectionPath is the derived projection file the database replaces.
var LegacyUsageProjectionPath = filepath.Join("stats", "llm_usage_projection.json")

func usageMigrations(stateDir string, pricing func() (*uniaiapi.PricingCatalog, string, error)) []sqlitedb.Migration {
	return []sqlitedb.Migration{
		{Name: "create llm usage", SQL: usageSchemaSQL + stateimport.MetaTableSQL},
		{Name: "import JSONL usage journal", Apply: func(ctx context.Context, tx *sql.Tx) error {
			return importUsageJournal(ctx, tx, stateDir, pricing)
		}},
	}
}

// PricingSource returns the pricing catalog and its digest.
type PricingSource func() (*uniaiapi.PricingCatalog, string, error)

// DefaultPricing is the catalog a store prices with until SetPricing changes it: uniai's
// built-in catalog.
func DefaultPricing() (*uniaiapi.PricingCatalog, string, error) {
	return defaultPricingSource()
}

var defaultPricingSource PricingSource = func() (*uniaiapi.PricingCatalog, string, error) {
	return loadPricingCatalog("", "")
}

// UsageStoreOptions change how a usage store behaves.
type UsageStoreOptions struct {
	// Pricing prices chat calls that report no cost. DefaultPricing when nil.
	Pricing PricingSource
	// RetentionDays deletes rows older than that, once a day; 0 keeps everything.
	RetentionDays int
	Logger        *slog.Logger
}

// UsageStore is the LLM usage in usage.db: one row per successful call.
type UsageStore struct {
	db      *sql.DB
	path    string
	logger  *slog.Logger
	now     func() time.Time
	release func()

	mu            sync.Mutex
	pricing       *uniaiapi.PricingCatalog
	pricingDigest string
	retentionDays int
	retentionNext time.Time
}

// OpenUsageStore opens usage.db at path. On first open it imports the JSONL journal in
// stats/llm_usage beside it, then renames that folder llm_usage.imported and deletes the
// projection file. Each Open must be matched by a Close; handles on one path share a connection
// pool within the process.
func OpenUsageStore(ctx context.Context, path string, opts UsageStoreOptions) (*UsageStore, error) {
	path = filepath.Clean(strings.TrimSpace(path))
	if path == "" || path == "." {
		return nil, fmt.Errorf("usage database path is required")
	}
	pricingSource := opts.Pricing
	if pricingSource == nil {
		pricingSource = defaultPricingSource
	}
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	stateDir := filepath.Dir(path)
	db, release, err := sharedUsageDBs.Acquire(path, func() (*sql.DB, error) {
		db, err := sqlitedb.Open(ctx, path, usageMigrations(stateDir, pricingSource))
		if err != nil {
			return nil, fmt.Errorf("open usage database: %w", err)
		}
		if err := stateimport.FinishRenames(ctx, db, stateDir, logger); err != nil {
			logger.Warn("llm_usage_import_rename_failed", "error", err)
		}
		return db, nil
	})
	if err != nil {
		return nil, err
	}
	store := &UsageStore{db: db, path: path, logger: logger, now: time.Now, release: release, retentionDays: opts.RetentionDays}
	catalog, digest, err := pricingSource()
	if err != nil {
		logger.Warn("llm_usage_pricing_unavailable", "error", err)
	} else if err := store.SetPricing(ctx, catalog, digest); err != nil {
		logger.Warn("llm_usage_reprice_failed", "error", err)
	}
	store.applyRetention(ctx)
	return store, nil
}

// Close releases the store's handle on the database.
func (s *UsageStore) Close() error {
	if s == nil || s.release == nil {
		return nil
	}
	s.release()
	s.release = nil
	return nil
}

// DB is the database, for tests and maintenance.
func (s *UsageStore) DB() *sql.DB { return s.db }

// SetPricing makes catalog the one new rows are priced with. When its digest differs from the
// one the rows were priced with, the catalog-priced rows, and chat rows no catalog priced yet,
// are priced again in batches before the digest is saved.
func (s *UsageStore) SetPricing(ctx context.Context, catalog *uniaiapi.PricingCatalog, digest string) error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	same := s.pricingDigest == digest && s.pricing == catalog
	s.pricing = catalog
	s.pricingDigest = digest
	s.mu.Unlock()
	if same && digest != "" {
		return nil
	}
	return s.reprice(ctx, catalog, digest)
}

func (s *UsageStore) reprice(ctx context.Context, catalog *uniaiapi.PricingCatalog, digest string) error {
	var saved string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, metaPricingDigest).Scan(&saved)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if saved == digest {
		return nil
	}
	var after int64
	for {
		n, last, err := s.repriceBatch(ctx, catalog, after)
		if err != nil {
			return err
		}
		if n == 0 {
			break
		}
		after = last
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, metaPricingDigest, digest)
	return err
}

func (s *UsageStore) repriceBatch(ctx context.Context, catalog *uniaiapi.PricingCatalog, after int64) (int, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, after, err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `SELECT id, model, input_tokens, output_tokens, total_tokens, cached_input_tokens,
		cache_creation_input_tokens, cache_details FROM llm_requests
		WHERE id > ? AND operation = 'chat' AND cost_source IN ('catalog', '') ORDER BY id LIMIT ?`, after, repriceBatch)
	if err != nil {
		return 0, after, err
	}
	type pending struct {
		id  int64
		rec RequestRecord
	}
	var batch []pending
	for rows.Next() {
		var p pending
		var details string
		p.rec.Operation = operationChat
		if err := rows.Scan(&p.id, &p.rec.Model, &p.rec.InputTokens, &p.rec.OutputTokens, &p.rec.TotalTokens,
			&p.rec.CachedInputTokens, &p.rec.CacheCreationInputTokens, &details); err != nil {
			_ = rows.Close()
			return 0, after, err
		}
		_ = json.Unmarshal([]byte(details), &p.rec.CacheDetails)
		batch = append(batch, p)
	}
	if err := rows.Close(); err != nil {
		return 0, after, err
	}
	for _, p := range batch {
		rec, source := priceRecord(p.rec, catalog)
		if _, err := tx.ExecContext(ctx, `UPDATE llm_requests SET cost_currency = ?, cost_estimated = ?, cost_source = ?,
			input_cost = ?, cached_input_cost = ?, cache_creation_input_cost = ?, output_cost = ?, total_cost = ? WHERE id = ?`,
			rec.CostCurrency, boolInt(rec.CostEstimated), source, rec.InputCost, rec.CachedInputCost,
			rec.CacheCreationInputCost, rec.OutputCost, rec.TotalCost, p.id); err != nil {
			return 0, after, err
		}
		after = p.id
	}
	if err := tx.Commit(); err != nil {
		return 0, after, err
	}
	return len(batch), after, nil
}

// priceRecord prices a chat record that reports no cost from the catalog. It returns the record
// and its cost_source.
func priceRecord(rec RequestRecord, catalog *uniaiapi.PricingCatalog) (RequestRecord, string) {
	if requestRecordHasCost(rec) {
		return rec, costSourceProvider
	}
	rec.CostCurrency, rec.CostEstimated = "", false
	rec.InputCost, rec.CachedInputCost, rec.CacheCreationInputCost, rec.OutputCost, rec.TotalCost = 0, 0, 0, 0, 0
	priced := backfillRequestCost(rec, catalog)
	if requestRecordHasCost(priced) {
		return priced, costSourceCatalog
	}
	return rec, ""
}

// Append records one call. A chat call that reports no cost is priced from the store's catalog.
func (s *UsageStore) Append(rec RequestRecord) error {
	return s.AppendContext(context.Background(), rec)
}

// AppendContext is Append with a context.
func (s *UsageStore) AppendContext(ctx context.Context, rec RequestRecord) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("usage store is not open")
	}
	rec = normalizeRequestRecord(rec)
	if err := validateRequestRecord(rec); err != nil {
		return err
	}
	ts, err := parseRecordTime(rec.TS)
	if err != nil {
		return err
	}
	s.mu.Lock()
	catalog := s.pricing
	s.mu.Unlock()
	var source string
	if rec.Operation == operationChat {
		rec, source = priceRecord(rec, catalog)
	} else if requestRecordHasCost(rec) {
		source = costSourceProvider
	}
	if err := insertRequest(ctx, s.db, rec, ts, source); err != nil {
		return err
	}
	s.applyRetention(ctx)
	return nil
}

type execer interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

func insertRequest(ctx context.Context, db execer, rec RequestRecord, ts time.Time, costSource string) error {
	details := "{}"
	if len(rec.CacheDetails) > 0 {
		data, err := json.Marshal(rec.CacheDetails)
		if err != nil {
			return err
		}
		details = string(data)
	}
	var evaluation any
	if rec.Evaluation != nil {
		data, err := json.Marshal(rec.Evaluation)
		if err != nil {
			return err
		}
		evaluation = string(data)
	}
	_, err := db.ExecContext(ctx, `INSERT INTO llm_requests (ts, run_id, origin_event_id, provider, api_base, api_host, model,
		operation, scene, input_tokens, output_tokens, total_tokens, cached_input_tokens, cache_creation_input_tokens,
		cache_details, cost_currency, cost_estimated, cost_source, input_cost, cached_input_cost, cache_creation_input_cost,
		output_cost, total_cost, duration_ms, evaluation)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		ts.UnixMilli(), rec.RunID, rec.OriginEventID, rec.Provider, rec.APIBase, rec.APIHost, rec.Model,
		rec.Operation, rec.Scene, rec.InputTokens, rec.OutputTokens, rec.TotalTokens, rec.CachedInputTokens,
		rec.CacheCreationInputTokens, details, rec.CostCurrency, boolInt(rec.CostEstimated), costSource,
		rec.InputCost, rec.CachedInputCost, rec.CacheCreationInputCost, rec.OutputCost, rec.TotalCost,
		rec.DurationMs, evaluation)
	if err != nil {
		return fmt.Errorf("record llm usage: %w", err)
	}
	return nil
}

func parseRecordTime(raw string) (time.Time, error) {
	raw = strings.TrimSpace(raw)
	ts, err := time.Parse(time.RFC3339Nano, raw)
	if err != nil {
		return time.Time{}, fmt.Errorf("ts %q: %w", raw, err)
	}
	return ts.UTC(), nil
}

// SetRetentionDays changes how many days of rows are kept; 0 keeps everything.
func (s *UsageStore) SetRetentionDays(days int) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.retentionDays = max(days, 0)
	s.retentionNext = time.Time{}
	s.mu.Unlock()
}

// applyRetention deletes rows older than the retention, at most once a day per database.
func (s *UsageStore) applyRetention(ctx context.Context) {
	s.mu.Lock()
	days := s.retentionDays
	due := !s.now().Before(s.retentionNext)
	if days > 0 && due {
		s.retentionNext = s.now().Add(time.Hour)
	}
	s.mu.Unlock()
	if days <= 0 || !due {
		return
	}
	if _, err := s.PurgeOlderThan(ctx, days, false); err != nil {
		s.logger.Warn("llm_usage_retention_failed", "error", err)
	}
}

// PurgeOlderThan deletes rows older than days days, unless the last purge ran within a day and
// force is false. It returns how many rows it deleted.
func (s *UsageStore) PurgeOlderThan(ctx context.Context, days int, force bool) (int64, error) {
	if days <= 0 {
		return 0, nil
	}
	now := s.now().UTC()
	if !force {
		var last string
		err := s.db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, metaRetentionRun).Scan(&last)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
		if at, err := time.Parse(time.RFC3339, last); err == nil && now.Sub(at) < 24*time.Hour {
			return 0, nil
		}
	}
	cutoff := now.AddDate(0, 0, -days).UnixMilli()
	var total int64
	for {
		res, err := s.db.ExecContext(ctx, `DELETE FROM llm_requests WHERE id IN
			(SELECT id FROM llm_requests WHERE ts < ? ORDER BY ts LIMIT 5000)`, cutoff)
		if err != nil {
			return total, err
		}
		n, _ := res.RowsAffected()
		total += n
		if n == 0 {
			break
		}
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, metaRetentionRun, now.Format(time.RFC3339))
	return total, err
}

// ImportRejects returns the JSONL lines the import skipped.
func (s *UsageStore) ImportRejects(ctx context.Context) (stateimport.RejectList, error) {
	return stateimport.Rejects(ctx, s.db, usageImportStore)
}

func boolInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

var sharedUsageDBs = sqlitedb.NewShared()

// UsageSink records a wrapped client's calls into usage.db. It opens the store on the first call,
// so wrapping a client costs nothing, and a client that is never used never opens the database.
type UsageSink struct {
	path   string
	logger *slog.Logger

	mu     sync.Mutex
	store  *UsageStore
	closed bool
}

// NewUsageSink returns a sink for usage.db at path.
func NewUsageSink(path string, logger *slog.Logger) *UsageSink {
	return &UsageSink{path: strings.TrimSpace(path), logger: logger}
}

// Path is the database the sink writes to.
func (s *UsageSink) Path() string {
	if s == nil {
		return ""
	}
	return s.path
}

// Record writes rec, logging rather than returning a failure: losing a usage row must not fail
// the call it describes.
func (s *UsageSink) Record(ctx context.Context, rec RequestRecord) {
	if s == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	// The call may have been cancelled after it returned; the row is still written.
	ctx = context.WithoutCancel(ctx)
	store, err := s.open(ctx)
	if err == nil {
		err = store.AppendContext(ctx, rec)
	}
	if err != nil && s.logger != nil {
		s.logger.Warn("llm_usage_record_error",
			"error", err.Error(),
			"provider", rec.Provider,
			"api_host", rec.APIHost,
			"model", rec.Model,
		)
	}
}

func (s *UsageSink) open(ctx context.Context) (*UsageStore, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.store != nil {
		return s.store, nil
	}
	if s.path == "" {
		return nil, fmt.Errorf("usage database path is required")
	}
	store, err := OpenUsageStore(ctx, s.path, UsageStoreOptions{Logger: s.logger, RetentionDays: configuredRetentionDays()})
	if err != nil {
		return nil, err
	}
	s.store = store
	s.closed = false
	return store, nil
}

// Close releases the sink's handle on the database; a later Record opens it again.
func (s *UsageSink) Close() error {
	if s == nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.store == nil {
		return nil
	}
	err := s.store.Close()
	s.store = nil
	s.closed = true
	return err
}
