package llmstats

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
)

// The coder quota table is no migration step: usage.db keeps the schema version a build without
// it knows, so going back to such a build still opens the file.
func TestCoderQuotaKeepsSchemaVersion(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "usage.db")

	// A usage.db an older build made: its migrations, no coder_quota table.
	db, err := sqlitedb.Open(ctx, path, usageMigrations(filepath.Dir(path), DefaultPricing))
	if err != nil {
		t.Fatalf("open as an older build: %v", err)
	}
	_ = db.Close()

	store, err := OpenUsageStore(ctx, path, UsageStoreOptions{})
	if err != nil {
		t.Fatalf("OpenUsageStore: %v", err)
	}
	observed := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	if err := store.PutCoderQuota(ctx, "codex", observed, []byte(`{"backend":"codex"}`)); err != nil {
		t.Fatalf("PutCoderQuota: %v", err)
	}
	var version int
	if err := store.db.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		t.Fatalf("user_version: %v", err)
	}
	if want := len(usageMigrations("", DefaultPricing)); version != want {
		t.Fatalf("user_version = %d, want %d", version, want)
	}
	_ = store.Close()

	// Opening again finds the table and the row.
	store, err = OpenUsageStore(ctx, path, UsageStoreOptions{})
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer store.Close()
	rows, err := store.CoderQuotas(ctx)
	if err != nil || len(rows) != 1 || rows[0].Backend != "codex" || !rows[0].ObservedAt.Equal(observed) {
		t.Fatalf("CoderQuotas = %+v, %v", rows, err)
	}
}
