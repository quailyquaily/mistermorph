package llmstats

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"os"
	"path/filepath"

	"github.com/quailyquaily/mistermorph/internal/pricingutil"
	"github.com/quailyquaily/mistermorph/internal/stateimport"
	uniaiapi "github.com/quailyquaily/uniai"
	"github.com/spf13/viper"
)

func loadPricingCatalog(pricingFile, configPath string) (*uniaiapi.PricingCatalog, string, error) {
	return pricingutil.LoadCatalog(pricingFile, configPath)
}

// ConfiguredPricing loads the catalog named by llm.pricing_file in the process config, or uniai's
// built-in catalog.
func ConfiguredPricing() (*uniaiapi.PricingCatalog, string, error) {
	return loadPricingCatalog(viper.GetString("llm.pricing_file"), viper.GetString("config"))
}

func init() {
	defaultPricingSource = ConfiguredPricing
}

// importUsageJournal copies the JSONL usage journal into llm_requests, oldest segment first. A
// line that does not parse or validate is listed in meta and skipped. Chat lines without a cost
// are priced from the catalog, as the projection priced them.
func importUsageJournal(ctx context.Context, tx *sql.Tx, stateDir string, pricing PricingSource) error {
	dir := filepath.Join(stateDir, LegacyUsageJournalDir)
	segments, err := listSegmentFiles(dir)
	if err != nil {
		return err
	}
	var catalog *uniaiapi.PricingCatalog
	digest := ""
	if pricing != nil {
		catalog, digest, err = pricing()
		if err != nil {
			catalog, digest = nil, ""
		}
	}
	var rejects []stateimport.Reject
	for _, seg := range segments {
		rel := filepath.ToSlash(filepath.Join(LegacyUsageJournalDir, seg.Key))
		if err := importUsageSegment(ctx, tx, filepath.Join(dir, seg.Key), rel, catalog, &rejects); err != nil {
			return err
		}
	}
	if err := stateimport.AddRejects(ctx, tx, usageImportStore, rejects); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, metaPricingDigest, digest); err != nil {
		return err
	}
	return stateimport.SetMark(ctx, tx, usageImportStore, stateDir,
		[]string{LegacyUsageJournalDir}, []string{LegacyUsageProjectionPath})
}

func importUsageSegment(ctx context.Context, tx *sql.Tx, path, rel string, catalog *uniaiapi.PricingCatalog, rejects *[]stateimport.Reject) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer func() { _ = file.Close() }()
	reader := bufio.NewReaderSize(file, 64*1024)
	line := 0
	for {
		raw, readErr := reader.ReadBytes('\n')
		if readErr != nil && readErr != io.EOF {
			return readErr
		}
		if len(raw) > 0 {
			line++
			if trimmed := bytes.TrimSpace(raw); len(trimmed) > 0 {
				if reject := importUsageLine(ctx, tx, trimmed, catalog); reject != nil {
					reject.Source, reject.Line = rel, line
					*rejects = append(*rejects, *reject)
				}
			}
		}
		if readErr == io.EOF {
			return nil
		}
	}
}

// importUsageLine inserts one line, or returns why it was rejected.
func importUsageLine(ctx context.Context, tx *sql.Tx, raw []byte, catalog *uniaiapi.PricingCatalog) *stateimport.Reject {
	var rec RequestRecord
	if err := json.Unmarshal(raw, &rec); err != nil {
		return &stateimport.Reject{Error: err.Error(), Raw: string(raw)}
	}
	rec = normalizeRequestRecord(rec)
	if err := validateRequestRecord(rec); err != nil {
		return &stateimport.Reject{Error: err.Error(), Raw: string(raw)}
	}
	ts, err := parseRecordTime(rec.TS)
	if err != nil {
		return &stateimport.Reject{Error: err.Error(), Raw: string(raw)}
	}
	source := ""
	if rec.Operation == operationChat {
		rec, source = priceRecord(rec, catalog)
	} else if requestRecordHasCost(rec) {
		source = costSourceProvider
	}
	if err := insertRequest(ctx, tx, rec, ts, source); err != nil {
		return &stateimport.Reject{Error: err.Error(), Raw: string(raw)}
	}
	return nil
}

// RetentionDaysKey is the setting that bounds how long usage rows are kept.
const RetentionDaysKey = "stats.llm_usage.retention_days"

func configuredRetentionDays() int {
	return max(viper.GetInt(RetentionDaysKey), 0)
}
