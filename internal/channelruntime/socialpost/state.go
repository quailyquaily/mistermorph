package socialpost

import (
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/fsstore"
)

const (
	seenRetention  = 14 * 24 * time.Hour
	maxSeenEntries = 5000
)

// state is what the runtime keeps across restarts in file_state_dir/socialpost/<channel>.json: the
// posts already handled, the users who opted out, and the day's post count.
type state struct {
	mu   sync.Mutex
	path string
	now  func() time.Time
	data stateFile
}

type stateFile struct {
	Seen     map[string]time.Time `json:"seen"`
	OptedOut map[string]time.Time `json:"opted_out"`
	Day      string               `json:"day,omitempty"`
	Posts    int                  `json:"posts,omitempty"`
}

func newState(stateDir, channel string, now func() time.Time) *state {
	s := &state{now: now}
	if strings.TrimSpace(stateDir) != "" {
		s.path = filepath.Join(stateDir, "socialpost", channel+".json")
		_, _ = fsstore.ReadJSON(s.path, &s.data)
	}
	if s.data.Seen == nil {
		s.data.Seen = map[string]time.Time{}
	}
	if s.data.OptedOut == nil {
		s.data.OptedOut = map[string]time.Time{}
	}
	return s
}

func (s *state) seen(postID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.data.Seen[postID]
	return ok
}

func (s *state) markSeen(postID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.data.Seen[postID] = s.now().UTC()
	cutoff := s.now().Add(-seenRetention)
	for id, at := range s.data.Seen {
		if at.Before(cutoff) {
			delete(s.data.Seen, id)
		}
	}
	if len(s.data.Seen) > maxSeenEntries {
		ids := make([]string, 0, len(s.data.Seen))
		for id := range s.data.Seen {
			ids = append(ids, id)
		}
		sort.Slice(ids, func(i, j int) bool { return s.data.Seen[ids[i]].Before(s.data.Seen[ids[j]]) })
		for _, id := range ids[:len(ids)-maxSeenEntries] {
			delete(s.data.Seen, id)
		}
	}
	s.saveLocked()
}

func (s *state) optedOut(userID string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, ok := s.data.OptedOut[userID]
	return ok
}

func (s *state) setOptOut(userID string, out bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if out {
		s.data.OptedOut[userID] = s.now().UTC()
	} else {
		delete(s.data.OptedOut, userID)
	}
	s.saveLocked()
}

// takePosts counts n posts against the day's limit, reporting false (and counting nothing) when
// they would go over it. A limit of 0 is no limit.
func (s *state) takePosts(n, limit int) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	day := s.now().UTC().Format("2006-01-02")
	if s.data.Day != day {
		s.data.Day, s.data.Posts = day, 0
	}
	if limit > 0 && s.data.Posts+n > limit {
		return false
	}
	s.data.Posts += n
	s.saveLocked()
	return true
}

// postsToday is the day's post count so far.
func (s *state) postsToday() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.data.Day != s.now().UTC().Format("2006-01-02") {
		return 0
	}
	return s.data.Posts
}

func (s *state) saveLocked() {
	if s.path == "" {
		return
	}
	_ = fsstore.WriteJSONAtomic(s.path, s.data, fsstore.FileOptions{DirPerm: 0o700, FilePerm: 0o600})
}
