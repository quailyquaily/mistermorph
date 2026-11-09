package contacts

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// LegacyProfile is what a contact recorded in persona_brief and topic_preferences before those
// became memories.
type LegacyProfile struct {
	ContactID        string
	PersonaBrief     string
	TopicPreferences []string
}

// legacyProfilesKey holds, in agent.db's meta, the legacy profile fields the contacts import found,
// until they are moved into memories.
const legacyProfilesKey = "contacts_legacy_profiles"

// TakeLegacyProfiles hands the legacy profile fields the contacts import kept to move and, once
// move succeeds, forgets them. Until then they stay, so nothing is lost when moving fails. It
// returns the time to pass next time; since is not needed any more and is returned when there is
// nothing to move.
func (s *DBStore) TakeLegacyProfiles(ctx context.Context, since time.Time, move func([]LegacyProfile) error) (time.Time, error) {
	db, err := s.handle(ctx)
	if err != nil {
		return since, err
	}
	var raw string
	err = db.QueryRowContext(ctx, `SELECT value FROM meta WHERE key = ?`, legacyProfilesKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return since, nil
	}
	if err != nil {
		return since, err
	}
	var profiles []LegacyProfile
	if err := json.Unmarshal([]byte(raw), &profiles); err != nil {
		return since, err
	}
	if len(profiles) > 0 {
		if err := move(profiles); err != nil {
			return since, err
		}
	}
	if _, err := db.ExecContext(ctx, `DELETE FROM meta WHERE key = ? AND value = ?`, legacyProfilesKey, raw); err != nil {
		return since, err
	}
	return time.Now().UTC(), nil
}
