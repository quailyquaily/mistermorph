package discordapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// rateLimiter follows Discord's rate limit headers. Each route (with its channel or message IDs, as
// Discord counts them) keeps the remaining count and reset time Discord last reported; a request
// waits while its route is exhausted, and a global 429 pauses every request. Routes that share one of
// Discord's buckets are tracked separately here, and the 429 retry covers what that misses.
type rateLimiter struct {
	mu          sync.Mutex
	now         func() time.Time
	sleepFn     func(context.Context, time.Duration) error
	routes      map[string]*routeLimit
	globalUntil time.Time
}

type routeLimit struct {
	remaining int
	resetAt   time.Time
	known     bool
}

func newRateLimiter(now func() time.Time, sleep func(context.Context, time.Duration) error) *rateLimiter {
	if now == nil {
		now = time.Now
	}
	if sleep == nil {
		sleep = sleepContext
	}
	return &rateLimiter{now: now, sleepFn: sleep, routes: make(map[string]*routeLimit)}
}

// wait blocks until a request on the route may go, and counts it.
func (l *rateLimiter) wait(ctx context.Context, route string) error {
	for {
		l.mu.Lock()
		now := l.now()
		delay := time.Duration(0)
		if now.Before(l.globalUntil) {
			delay = l.globalUntil.Sub(now)
		} else if limit := l.routes[route]; limit != nil && limit.known {
			if now.After(limit.resetAt) || now.Equal(limit.resetAt) {
				limit.known = false
			} else if limit.remaining <= 0 {
				delay = limit.resetAt.Sub(now)
			} else {
				limit.remaining--
			}
		}
		l.mu.Unlock()
		if delay <= 0 {
			return nil
		}
		if err := l.sleepFn(ctx, delay); err != nil {
			return err
		}
	}
}

// update records the limit Discord reported for the route.
func (l *rateLimiter) update(route string, header http.Header) {
	remainingRaw := strings.TrimSpace(header.Get("X-RateLimit-Remaining"))
	resetAfter := parseSeconds(header.Get("X-RateLimit-Reset-After"))
	if remainingRaw == "" || resetAfter <= 0 {
		return
	}
	remaining, err := strconv.Atoi(remainingRaw)
	if err != nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.routes[route] = &routeLimit{remaining: remaining, resetAt: l.now().Add(resetAfter), known: true}
}

// limited records a 429: the route, or every route when global, waits retryAfter.
func (l *rateLimiter) limited(route string, retryAfter time.Duration, global bool) {
	if retryAfter <= 0 {
		retryAfter = time.Second
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	until := l.now().Add(retryAfter)
	if global {
		if until.After(l.globalUntil) {
			l.globalUntil = until
		}
		return
	}
	l.routes[route] = &routeLimit{remaining: 0, resetAt: until, known: true}
}

func (l *rateLimiter) sleep(ctx context.Context, d time.Duration) error {
	return l.sleepFn(ctx, d)
}

func sleepContext(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func parseSeconds(raw string) time.Duration {
	value, err := strconv.ParseFloat(strings.TrimSpace(raw), 64)
	if err != nil || value <= 0 {
		return 0
	}
	return time.Duration(value * float64(time.Second))
}
