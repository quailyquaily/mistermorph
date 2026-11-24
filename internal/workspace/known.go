package workspace

import (
	"context"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
)

// MaxRecentUses is how many workspaces workspace_uses keeps: the most recently used.
const MaxRecentUses = 100

// AttachmentRecord is one conversation's attached workspace and when it was attached.
type AttachmentRecord struct {
	ScopeKey     string
	WorkspaceDir string
	UpdatedAt    time.Time
}

// Use is when a workspace was last used by a run.
type Use struct {
	WorkspaceDir string
	UsedAt       time.Time
}

// ListAttachments lists the attachments whose scope key starts with prefix (such as "console:"),
// most recently attached first. A workspace.json the import left in a topic's folder is read only
// when that topic is asked for (Get), so it is not listed here until then.
func (s *Store) ListAttachments(prefix string) ([]AttachmentRecord, error) {
	if s == nil || s.stateDir == "" {
		return nil, nil
	}
	ctx := context.Background()
	db, err := s.db.Get(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT scope_key, workspace_dir, updated_at FROM workspace_attachments
		WHERE substr(scope_key, 1, length(?)) = ? ORDER BY updated_at DESC, scope_key`, prefix, prefix)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []AttachmentRecord
	for rows.Next() {
		var rec AttachmentRecord
		var updated string
		if err := rows.Scan(&rec.ScopeKey, &rec.WorkspaceDir, &updated); err != nil {
			return nil, err
		}
		rec.WorkspaceDir = strings.TrimSpace(rec.WorkspaceDir)
		if rec.WorkspaceDir == "" {
			continue
		}
		rec.UpdatedAt, _ = agentdb.ParseTime(updated)
		out = append(out, rec)
	}
	return out, rows.Err()
}

// RecordUse notes that a run used dir at at, keeping the MaxRecentUses most recent workspaces.
func (s *Store) RecordUse(dir string, at time.Time) error {
	dir = strings.TrimSpace(dir)
	if s == nil || s.stateDir == "" || dir == "" {
		return nil
	}
	if at.IsZero() {
		at = time.Now()
	}
	ctx := context.Background()
	db, err := s.db.Get(ctx)
	if err != nil {
		return err
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `INSERT INTO workspace_uses (workspace_dir, used_at) VALUES (?, ?)
		ON CONFLICT (workspace_dir) DO UPDATE SET used_at = max(used_at, excluded.used_at)`,
		dir, agentdb.FormatTime(at)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `DELETE FROM workspace_uses WHERE workspace_dir NOT IN (
		SELECT workspace_dir FROM workspace_uses ORDER BY used_at DESC, workspace_dir LIMIT ?)`, MaxRecentUses); err != nil {
		return err
	}
	return tx.Commit()
}

// RecentUses lists the most recently used workspaces, newest first, at most limit of them.
func (s *Store) RecentUses(limit int) ([]Use, error) {
	if s == nil || s.stateDir == "" {
		return nil, nil
	}
	if limit <= 0 || limit > MaxRecentUses {
		limit = MaxRecentUses
	}
	ctx := context.Background()
	db, err := s.db.Get(ctx)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT workspace_dir, used_at FROM workspace_uses ORDER BY used_at DESC, workspace_dir LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Use
	for rows.Next() {
		var use Use
		var at string
		if err := rows.Scan(&use.WorkspaceDir, &at); err != nil {
			return nil, err
		}
		use.UsedAt, _ = agentdb.ParseTime(at)
		out = append(out, use)
	}
	return out, rows.Err()
}
