package llmstats

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// coderQuotaSchemaSQL keeps the last subscription quota each local coding CLI reported (Codex,
// Claude Code): one row per coder, replaced by every newer report. The quota itself is the
// coder's own JSON (internal/coderusage), stored as given.
const coderQuotaSchemaSQL = `
CREATE TABLE coder_quota (
	backend     TEXT PRIMARY KEY,
	observed_at INTEGER NOT NULL,
	data        TEXT NOT NULL
);
`

// CoderQuotaRow is one coder's last reported quota.
type CoderQuotaRow struct {
	Backend    string
	ObservedAt time.Time
	Data       []byte
}

// PutCoderQuota saves backend's quota observed at observedAt, unless the saved one is newer.
func (s *UsageStore) PutCoderQuota(ctx context.Context, backend string, observedAt time.Time, data []byte) error {
	if s == nil || s.db == nil {
		return fmt.Errorf("usage store is not open")
	}
	backend = strings.TrimSpace(backend)
	if backend == "" {
		return fmt.Errorf("coder quota: backend is required")
	}
	if len(data) == 0 {
		return fmt.Errorf("coder quota: data is required")
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO coder_quota (backend, observed_at, data) VALUES (?, ?, ?)
		ON CONFLICT (backend) DO UPDATE SET observed_at = excluded.observed_at, data = excluded.data
		WHERE excluded.observed_at >= coder_quota.observed_at`,
		backend, observedAt.UTC().UnixMilli(), string(data))
	return err
}

// CoderQuotas returns every coder's last quota, by backend.
func (s *UsageStore) CoderQuotas(ctx context.Context) ([]CoderQuotaRow, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("usage store is not open")
	}
	rows, err := s.db.QueryContext(ctx, `SELECT backend, observed_at, data FROM coder_quota ORDER BY backend`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CoderQuotaRow
	for rows.Next() {
		var row CoderQuotaRow
		var observed int64
		var data string
		if err := rows.Scan(&row.Backend, &observed, &data); err != nil {
			return nil, err
		}
		row.ObservedAt = time.UnixMilli(observed).UTC()
		row.Data = []byte(data)
		out = append(out, row)
	}
	return out, rows.Err()
}

// PutCoderQuota saves a coder's quota through the sink, logging rather than returning a failure.
func (s *UsageSink) PutCoderQuota(ctx context.Context, backend string, observedAt time.Time, data []byte) {
	if s == nil {
		return
	}
	if ctx == nil {
		ctx = context.Background()
	}
	ctx = context.WithoutCancel(ctx)
	store, err := s.open(ctx)
	if err == nil {
		err = store.PutCoderQuota(ctx, backend, observedAt, data)
	}
	if err != nil && s.logger != nil {
		s.logger.Warn("coder_quota_record_error", "error", err.Error(), "backend", backend)
	}
}
