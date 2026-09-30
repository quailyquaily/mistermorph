package discord

import "sync"

// discordIngressQueueCap bounds the messages waiting in one channel while an earlier one is handled.
const discordIngressQueueCap = 64

// keyedQueue runs functions one at a time per key, in the order they were pushed, so the Gateway's
// read loop never waits on a download or a trigger decision while a channel's order is kept.
type keyedQueue struct {
	mu     sync.Mutex
	queues map[string][]func()
	wg     sync.WaitGroup
}

func newKeyedQueue() *keyedQueue {
	return &keyedQueue{queues: make(map[string][]func())}
}

// push queues fn under key. It returns false when that key's queue is full.
func (q *keyedQueue) push(key string, fn func()) bool {
	q.mu.Lock()
	pending, running := q.queues[key]
	if len(pending) >= discordIngressQueueCap {
		q.mu.Unlock()
		return false
	}
	q.queues[key] = append(pending, fn)
	if !running {
		q.wg.Add(1)
		go q.drain(key)
	}
	q.mu.Unlock()
	return true
}

func (q *keyedQueue) drain(key string) {
	defer q.wg.Done()
	for {
		q.mu.Lock()
		pending := q.queues[key]
		if len(pending) == 0 {
			delete(q.queues, key)
			q.mu.Unlock()
			return
		}
		fn := pending[0]
		q.queues[key] = pending[1:]
		q.mu.Unlock()
		fn()
	}
}

// wait blocks until every queued function has run.
func (q *keyedQueue) wait() {
	q.wg.Wait()
}
