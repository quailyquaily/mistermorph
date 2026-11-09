package sqlitedb

import (
	"database/sql"
	"os"
	"path/filepath"
	"sync"
)

// Shared keeps one *sql.DB per database path in a process, shared by every handle on it, and
// closes it when the last handle is released. Stores that many short-lived callers open, such as
// a usage store per wrapped LLM client, use it so the process has one connection pool per file.
type Shared struct {
	mu  sync.Mutex
	dbs map[string]*sharedEntry
}

type sharedEntry struct {
	db   *sql.DB
	refs int
	// file is the database file when it was opened. A file deleted or replaced since then (a test
	// that removes its state folder, a restore) gets a new pool rather than the stale one.
	file os.FileInfo
}

// NewShared returns an empty set of shared databases.
func NewShared() *Shared {
	return &Shared{dbs: map[string]*sharedEntry{}}
}

// Acquire returns the database at path, calling open when no handle on it is held, and a release
// function that must be called once when the caller is done with it.
func (s *Shared) Acquire(path string, open func() (*sql.DB, error)) (*sql.DB, func(), error) {
	key := filepath.Clean(path)
	if abs, err := filepath.Abs(key); err == nil {
		key = abs
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	entry := s.dbs[key]
	if entry != nil && entry.file != nil {
		if current, err := os.Stat(key); err != nil || !os.SameFile(current, entry.file) {
			// Holders of the old pool keep it until they release it.
			delete(s.dbs, key)
			entry = nil
		}
	}
	if entry == nil {
		db, err := open()
		if err != nil {
			return nil, nil, err
		}
		entry = &sharedEntry{db: db}
		if info, err := os.Stat(key); err == nil {
			entry.file = info
		}
		s.dbs[key] = entry
	}
	entry.refs++
	var once sync.Once
	release := func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			entry.refs--
			if entry.refs == 0 {
				_ = entry.db.Close()
				if s.dbs[key] == entry {
					delete(s.dbs, key)
				}
			}
		})
	}
	return entry.db, release, nil
}
