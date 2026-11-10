package runtimecontrol

import (
	"errors"
	"fmt"
	"strings"
	"sync"
)

const defaultSteerQueueLimit = 32

var (
	ErrSteerInputEmpty  = errors.New("steer input is empty")
	ErrSteerQueueClosed = errors.New("steer queue is closed")
	ErrSteerQueueFull   = errors.New("steer queue is full")
)

// SteerOutcome is what became of one queued steer input.
type SteerOutcome int

const (
	// SteerPending: the input waits in the queue for the run's next checkpoint.
	SteerPending SteerOutcome = iota
	// SteerApplied: the run took the input in.
	SteerApplied
	// SteerDropped: the run ended before it took the input in.
	SteerDropped
	// SteerStopped: the run was stopped before it took the input in.
	SteerStopped
)

// SteerTicket follows one queued input until the run takes it in or drops it.
type SteerTicket struct {
	mu      sync.Mutex
	outcome SteerOutcome
	done    chan struct{}
}

func newSteerTicket() *SteerTicket {
	return &SteerTicket{done: make(chan struct{})}
}

// Outcome is the input's outcome so far.
func (t *SteerTicket) Outcome() SteerOutcome {
	if t == nil {
		return SteerPending
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.outcome
}

// Done is closed once the input is applied or dropped.
func (t *SteerTicket) Done() <-chan struct{} {
	if t == nil {
		return nil
	}
	return t.done
}

func (t *SteerTicket) resolve(outcome SteerOutcome) {
	if t == nil || outcome == SteerPending {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.outcome != SteerPending {
		return
	}
	t.outcome = outcome
	close(t.done)
}

type steerItem struct {
	text   string
	ticket *SteerTicket
}

type SteerQueue struct {
	mu     sync.Mutex
	limit  int
	items  []steerItem
	closed bool
}

func NewSteerQueue(limit int) *SteerQueue {
	if limit <= 0 {
		limit = defaultSteerQueueLimit
	}
	return &SteerQueue{limit: limit}
}

func (q *SteerQueue) Push(input string) (int, error) {
	_, n, err := q.PushTicket(input)
	return n, err
}

// PushTicket queues input like Push and returns the ticket that tells whether the run took it in.
func (q *SteerQueue) PushTicket(input string) (*SteerTicket, int, error) {
	if q == nil {
		return nil, 0, fmt.Errorf("steer queue is nil")
	}
	input = strings.TrimSpace(input)
	if input == "" {
		return nil, q.Len(), ErrSteerInputEmpty
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return nil, len(q.items), ErrSteerQueueClosed
	}
	if q.limit > 0 && len(q.items) >= q.limit {
		return nil, len(q.items), ErrSteerQueueFull
	}
	ticket := newSteerTicket()
	q.items = append(q.items, steerItem{text: input, ticket: ticket})
	return ticket, len(q.items), nil
}

// Close closes the queue; inputs still in it are dropped.
func (q *SteerQueue) Close() {
	q.closeAs(SteerDropped)
}

func (q *SteerQueue) closeAs(outcome SteerOutcome) {
	if q == nil {
		return
	}
	q.mu.Lock()
	q.closed = true
	items := q.items
	q.items = nil
	q.mu.Unlock()
	for _, item := range items {
		item.ticket.resolve(outcome)
	}
}

func (q *SteerQueue) DrainAndClose() []string {
	return q.drain(true)
}

func (q *SteerQueue) Drain() []string {
	return q.drain(false)
}

func (q *SteerQueue) drain(closeQueue bool) []string {
	if q == nil {
		return nil
	}
	q.mu.Lock()
	if closeQueue {
		q.closed = true
	}
	items := q.items
	q.items = nil
	q.mu.Unlock()
	if len(items) == 0 {
		return nil
	}
	out := make([]string, len(items))
	for i, item := range items {
		out[i] = item.text
		item.ticket.resolve(SteerApplied)
	}
	return out
}

func (q *SteerQueue) Len() int {
	if q == nil {
		return 0
	}
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.items)
}
