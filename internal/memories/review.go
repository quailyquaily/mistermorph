package memories

import (
	"context"
	"fmt"
	"time"

	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
)

// CountTurn adds one finished turn to a's count of turns since a memory was saved from it, and
// returns the new count.
func (s *Store) CountTurn(ctx context.Context, a audience.Audience) (int, error) {
	if a.IsZero() {
		return 0, nil
	}
	now := s.now().UTC().Format(time.RFC3339Nano)
	var turns int
	err := s.db.QueryRowContext(ctx, `INSERT INTO memory_review (audience, turns_since_save, updated_at) VALUES (?, 1, ?)
		ON CONFLICT (audience) DO UPDATE SET turns_since_save = turns_since_save + 1, updated_at = excluded.updated_at
		RETURNING turns_since_save`, a.String(), now).Scan(&turns)
	if err != nil {
		return 0, fmt.Errorf("count memory turn: %w", err)
	}
	return turns, nil
}

// TakeReminder reports whether a has gone threshold turns without a save, with the count, and if
// so sets the count to zero, so one reminder is given per stretch whether or not the run saves.
func (s *Store) TakeReminder(ctx context.Context, a audience.Audience, threshold int) (int, bool, error) {
	if a.IsZero() || threshold <= 0 {
		return 0, false, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, false, fmt.Errorf("take memory reminder: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var turns int
	err = tx.QueryRowContext(ctx, `SELECT turns_since_save FROM memory_review WHERE audience = ?`, a.String()).Scan(&turns)
	if sqlitedb.IsNoRows(err) || (err == nil && turns < threshold) {
		return turns, false, nil
	}
	if err != nil {
		return 0, false, fmt.Errorf("take memory reminder: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `UPDATE memory_review SET turns_since_save = 0, updated_at = ? WHERE audience = ?`,
		s.now().UTC().Format(time.RFC3339Nano), a.String()); err != nil {
		return 0, false, fmt.Errorf("take memory reminder: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, false, fmt.Errorf("take memory reminder: %w", err)
	}
	return turns, true, nil
}
