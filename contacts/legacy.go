package contacts

import (
	"context"
	"os"
	"time"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

// LegacyProfile is what a contact recorded in persona_brief and topic_preferences before those
// became memories.
type LegacyProfile struct {
	ContactID        string
	PersonaBrief     string
	TopicPreferences []string
}

// TakeLegacyProfiles hands the contacts' legacy profile fields to move and, once move succeeds,
// removes them from the contacts files. It does nothing when the files have not changed since
// since, and returns the time to pass next time. Until move succeeds the fields stay in the files,
// so nothing is lost when moving fails.
func (s *FileStore) TakeLegacyProfiles(ctx context.Context, since time.Time, move func([]LegacyProfile) error) (time.Time, error) {
	if err := ensureNotCanceled(ctx); err != nil {
		return since, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	lockPath, err := s.stateLockPath()
	if err != nil {
		return since, err
	}
	checked := since
	err = fsstore.WithLock(ctx, lockPath, func() error {
		modified := s.contactsModTimeLocked()
		if !since.IsZero() && !modified.After(since) {
			return nil
		}
		active, err := s.loadContactsMarkdownLocked(s.activeContactsPath(), StatusActive)
		if err != nil {
			return err
		}
		inactive, err := s.loadContactsMarkdownLocked(s.inactiveContactsPath(), StatusInactive)
		if err != nil {
			return err
		}
		var profiles []LegacyProfile
		for _, items := range [][]Contact{active, inactive} {
			for _, item := range items {
				if !item.legacy.empty() {
					profiles = append(profiles, LegacyProfile{
						ContactID:        item.ContactID,
						PersonaBrief:     item.legacy.personaBrief,
						TopicPreferences: append([]string(nil), item.legacy.topicPreferences...),
					})
				}
			}
		}
		if len(profiles) == 0 {
			checked = modified
			return nil
		}
		if err := move(profiles); err != nil {
			return err
		}
		for _, items := range [][]Contact{active, inactive} {
			for i := range items {
				items[i].legacy = legacyProfile{}
			}
		}
		if err := s.saveContactsMarkdownLocked(s.activeContactsPath(), "Active Contacts", StatusActive, active); err != nil {
			return err
		}
		if err := s.saveContactsMarkdownLocked(s.inactiveContactsPath(), "Inactive Contacts", StatusInactive, inactive); err != nil {
			return err
		}
		checked = s.contactsModTimeLocked()
		return nil
	})
	return checked, err
}

func (s *FileStore) contactsModTimeLocked() time.Time {
	var latest time.Time
	for _, path := range []string{s.activeContactsPath(), s.inactiveContactsPath()} {
		if info, err := os.Stat(path); err == nil && info.ModTime().After(latest) {
			latest = info.ModTime()
		}
	}
	return latest
}
