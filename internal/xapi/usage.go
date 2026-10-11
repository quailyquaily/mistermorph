package xapi

import (
	"sync"
	"time"
)

// Usage kinds, as X bills them.
const (
	UsagePostReads      = "post_reads"
	UsageOwnedReads     = "owned_reads"
	UsageUserReads      = "user_reads"
	UsageDMReads        = "dm_reads"
	UsagePostsCreated   = "posts_created"
	UsagePostsWithLinks = "posts_with_links"
	UsageDMsSent        = "dms_sent"
)

// UsageSnapshot is a UTC day's counts by kind.
type UsageSnapshot struct {
	Day    string         `json:"day"`
	Counts map[string]int `json:"counts"`
}

// Usage counts the day's billable calls. X deduplicates resources within a UTC day, so this is an
// upper bound on what is billed.
type Usage struct {
	mu     sync.Mutex
	now    func() time.Time
	day    string
	counts map[string]int
}

func newUsage(now func() time.Time) *Usage {
	return &Usage{now: now, counts: map[string]int{}}
}

func (u *Usage) add(kind string, n int) {
	if n <= 0 {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.rollLocked()
	u.counts[kind] += n
}

func (u *Usage) snapshot() UsageSnapshot {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.rollLocked()
	counts := make(map[string]int, len(u.counts))
	for kind, n := range u.counts {
		counts[kind] = n
	}
	return UsageSnapshot{Day: u.day, Counts: counts}
}

func (u *Usage) rollLocked() {
	day := u.now().UTC().Format("2006-01-02")
	if u.day != day {
		u.day = day
		u.counts = map[string]int{}
	}
}
