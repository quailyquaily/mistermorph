package consolecmd

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// The topic task completions a client that was away can still read: the Android app's background
// watcher (web/console-nsh/android/src, TaskNotifier) asks for them over plain HTTP while the app is
// not in the foreground, because the console's notification socket lives in the app's page, which
// Android suspends there. Only identifiers and status, as on the socket.
const (
	taskCompletionLogLimit = 256
	taskCompletionLogAge   = 24 * time.Hour
	// How long a request waits for a completion before it answers with none; below the minute
	// proxies commonly allow an idle response.
	notificationEventsMaxWait = 50 * time.Second
)

type loggedTaskCompletion struct {
	seq          int64
	at           time.Time
	notification consoleNotification
}

type taskCompletionLog struct {
	now func() time.Time

	mu sync.Mutex
	// Changes with every server start: a cursor of an earlier one means nothing here.
	epoch   string
	seq     int64
	entries []loggedTaskCompletion
	// The tasks in the person's topics that are queued or running: while there are some, a
	// watcher keeps asking; without any it may ask rarely.
	active map[string]struct{}
	// Closed and replaced by every completion: what a waiting request waits on.
	changed chan struct{}
}

func newTaskCompletionLog(now func() time.Time) *taskCompletionLog {
	var raw [8]byte
	_, _ = rand.Read(raw[:])
	return &taskCompletionLog{
		now:     now,
		epoch:   hex.EncodeToString(raw[:]),
		active:  map[string]struct{}{},
		changed: make(chan struct{}),
	}
}

func (l *taskCompletionLog) track(task daemonruntime.TaskInfo) {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	switch task.Status {
	case daemonruntime.TaskQueued, daemonruntime.TaskRunning, daemonruntime.TaskPending:
		l.active[task.ID] = struct{}{}
	default:
		delete(l.active, task.ID)
	}
}

func (l *taskCompletionLog) add(notification consoleNotification) {
	if l == nil || notification.ID == "" {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.seq++
	l.entries = append(l.entries, loggedTaskCompletion{seq: l.seq, at: l.now(), notification: notification})
	l.pruneLocked()
	close(l.changed)
	l.changed = make(chan struct{})
}

func (l *taskCompletionLog) pruneLocked() {
	cutoff := l.now().Add(-taskCompletionLogAge)
	drop := 0
	for drop < len(l.entries) && (len(l.entries)-drop > taskCompletionLogLimit || l.entries[drop].at.Before(cutoff)) {
		drop++
	}
	if drop > 0 {
		l.entries = append([]loggedTaskCompletion(nil), l.entries[drop:]...)
	}
}

// taskCompletionQuery is what a watcher asks: the completions after its cursor when the cursor is
// of this server start (epoch), else those of the last `since` (the time it has been away, by its
// own clock: no clock is compared across machines).
type taskCompletionQuery struct {
	epoch string
	after int64
	since time.Duration
}

type taskCompletionPage struct {
	Epoch  string                `json:"epoch"`
	Cursor int64                 `json:"cursor"`
	Active int                   `json:"active"`
	Events []consoleNotification `json:"events"`
}

// read answers q now, with the channel a waiting request waits on for the next completion.
func (l *taskCompletionLog) read(q taskCompletionQuery) (taskCompletionPage, <-chan struct{}) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.pruneLocked()
	page := taskCompletionPage{Epoch: l.epoch, Cursor: l.seq, Active: len(l.active), Events: []consoleNotification{}}
	known := q.epoch == l.epoch && q.after >= 0 && q.after <= l.seq
	since := q.since
	if since > taskCompletionLogAge {
		since = taskCompletionLogAge
	}
	cutoff := l.now().Add(-since)
	for _, entry := range l.entries {
		if known && entry.seq <= q.after {
			continue
		}
		if !known && (since <= 0 || entry.at.Before(cutoff)) {
			continue
		}
		page.Events = append(page.Events, entry.notification)
	}
	return page, l.changed
}

func (s *server) handleNotificationEvents(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if s == nil || s.localRuntime == nil || s.localRuntime.notificationHub == nil || s.localRuntime.notificationHub.completions == nil {
		writeError(w, http.StatusServiceUnavailable, "notifications are unavailable")
		return
	}
	completions := s.localRuntime.notificationHub.completions
	query := r.URL.Query()
	q := taskCompletionQuery{epoch: strings.TrimSpace(query.Get("epoch")), after: -1}
	if raw := strings.TrimSpace(query.Get("after")); raw != "" {
		after, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || after < 0 {
			writeError(w, http.StatusBadRequest, "invalid after")
			return
		}
		q.after = after
	}
	if raw := strings.TrimSpace(query.Get("since_ms")); raw != "" {
		ms, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || ms < 0 {
			writeError(w, http.StatusBadRequest, "invalid since_ms")
			return
		}
		q.since = time.Duration(min(ms, int64(taskCompletionLogAge/time.Millisecond))) * time.Millisecond
	}
	var wait time.Duration
	if raw := strings.TrimSpace(query.Get("wait")); raw != "" {
		seconds, err := strconv.Atoi(raw)
		if err != nil || seconds < 0 {
			writeError(w, http.StatusBadRequest, "invalid wait")
			return
		}
		wait = min(time.Duration(seconds)*time.Second, notificationEventsMaxWait)
	}

	page, changed := completions.read(q)
	if len(page.Events) == 0 && wait > 0 {
		// Wait from where this answer stands, so a completion while waiting is the next one read.
		q = taskCompletionQuery{epoch: page.Epoch, after: page.Cursor}
		timer := time.NewTimer(wait)
		defer timer.Stop()
		select {
		case <-changed:
			page, _ = completions.read(q)
		case <-timer.C:
			page, _ = completions.read(q)
		case <-r.Context().Done():
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, page)
}
