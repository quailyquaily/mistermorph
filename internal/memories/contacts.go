package memories

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/contacts"
	"github.com/quailyquaily/mistermorph/internal/audience"
	"github.com/quailyquaily/mistermorph/internal/sqlitedb"
)

const contactsCheckedKey = "contacts_profiles_checked_at"

// MoveContactProfiles turns the contacts' legacy persona_brief and topic_preferences into person
// memories about each contact, learned from the owner (who wrote them in the contacts file) and
// private. The fields leave the contacts file only after the memories are saved, and the files
// are read again only when they change.
func (s *Store) MoveContactProfiles(ctx context.Context, store *contacts.FileStore) (int, error) {
	if s == nil || store == nil {
		return 0, nil
	}
	since, err := s.metaTime(ctx, contactsCheckedKey)
	if err != nil {
		return 0, err
	}
	moved := 0
	checked, err := store.TakeLegacyProfiles(ctx, since, func(profiles []contacts.LegacyProfile) error {
		for _, profile := range profiles {
			subject := audience.Contact(profile.ContactID).String()
			if subject == "" {
				continue
			}
			if brief := strings.TrimSpace(profile.PersonaBrief); brief != "" {
				if _, err := s.Save(ctx, audience.Owner(), Draft{
					Subject: subject, Name: "persona", Type: TypePerson,
					Description: "What " + profile.ContactID + " is like (from the contact's persona_brief)",
					Body:        brief,
				}); err != nil {
					return fmt.Errorf("move persona_brief of %s: %w", profile.ContactID, err)
				}
				moved++
			}
			if len(profile.TopicPreferences) > 0 {
				if _, err := s.Save(ctx, audience.Owner(), Draft{
					Subject: subject, Name: "topic-preferences", Type: TypePerson,
					Description: "Topics " + profile.ContactID + " cares about (from the contact's topic_preferences)",
					Body:        "Topics they care about: " + strings.Join(profile.TopicPreferences, ", ") + ".",
				}); err != nil {
					return fmt.Errorf("move topic_preferences of %s: %w", profile.ContactID, err)
				}
				moved++
			}
		}
		return nil
	})
	if err != nil {
		return moved, err
	}
	if !checked.IsZero() && !checked.Equal(since) {
		if err := s.setMetaTime(ctx, contactsCheckedKey, checked); err != nil {
			return moved, err
		}
	}
	return moved, nil
}

func (s *Store) metaTime(ctx context.Context, key string) (time.Time, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT value FROM memory_meta WHERE key = ?`, key).Scan(&raw)
	if sqlitedb.IsNoRows(err) {
		return time.Time{}, nil
	}
	if err != nil {
		return time.Time{}, fmt.Errorf("read memory meta: %w", err)
	}
	at, _ := time.Parse(time.RFC3339Nano, raw)
	return at, nil
}

func (s *Store) setMetaTime(ctx context.Context, key string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO memory_meta (key, value) VALUES (?, ?)
		ON CONFLICT (key) DO UPDATE SET value = excluded.value`, key, at.UTC().Format(time.RFC3339Nano))
	if err != nil {
		return fmt.Errorf("write memory meta: %w", err)
	}
	return nil
}
