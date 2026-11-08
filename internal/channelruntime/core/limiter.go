package core

import (
	"container/list"
	"context"
	"sync"
)

// ConversationLimiter bounds how many conversations a ConversationRunner handles at once.
// Acquire blocks until a slot is free or ctx ends; every successful Acquire is paired with
// one Release.
type ConversationLimiter interface {
	Acquire(ctx context.Context) error
	Release()
}

// chanLimiter is the fixed-size channel semaphore the channel runtimes pass in.
type chanLimiter chan struct{}

func (l chanLimiter) Acquire(ctx context.Context) error {
	select {
	case l <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (l chanLimiter) Release() { <-l }

// ResizableLimiter is a FIFO counting semaphore whose limit can change while slots are held.
// Raising the limit admits waiters at once; lowering it lets running holders finish and admits
// no one until fewer than the new limit are active.
type ResizableLimiter struct {
	mu      sync.Mutex
	limit   int
	active  int
	waiters list.List // of chan struct{}, closed when granted
}

// NewResizableLimiter returns a limiter admitting limit holders at once; limits below 1 mean 1.
func NewResizableLimiter(limit int) *ResizableLimiter {
	l := &ResizableLimiter{}
	l.limit = normalizeLimiterLimit(limit)
	return l
}

func normalizeLimiterLimit(limit int) int {
	if limit < 1 {
		return 1
	}
	return limit
}

// SetLimit changes the limit; values below 1 mean 1.
func (l *ResizableLimiter) SetLimit(limit int) {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.limit = normalizeLimiterLimit(limit)
	l.grantLocked()
	l.mu.Unlock()
}

// Limit reports the current limit.
func (l *ResizableLimiter) Limit() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.limit
}

// Active reports how many slots are held.
func (l *ResizableLimiter) Active() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.active
}

// Waiting reports how many callers are blocked in Acquire.
func (l *ResizableLimiter) Waiting() int {
	if l == nil {
		return 0
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.waiters.Len()
}

func (l *ResizableLimiter) Acquire(ctx context.Context) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	l.mu.Lock()
	if l.waiters.Len() == 0 && l.active < l.limit {
		l.active++
		l.mu.Unlock()
		return nil
	}
	ready := make(chan struct{})
	elem := l.waiters.PushBack(ready)
	l.mu.Unlock()

	select {
	case <-ready:
		return nil
	case <-ctx.Done():
		l.mu.Lock()
		select {
		case <-ready:
			// Granted while giving up: hand the slot on.
			l.active--
			l.grantLocked()
		default:
			l.waiters.Remove(elem)
		}
		l.mu.Unlock()
		return ctx.Err()
	}
}

func (l *ResizableLimiter) Release() {
	l.mu.Lock()
	if l.active > 0 {
		l.active--
	}
	l.grantLocked()
	l.mu.Unlock()
}

func (l *ResizableLimiter) grantLocked() {
	for l.active < l.limit {
		front := l.waiters.Front()
		if front == nil {
			return
		}
		l.waiters.Remove(front)
		l.active++
		close(front.Value.(chan struct{}))
	}
}
