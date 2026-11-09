package core

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"
)

const limiterTestTimeout = 5 * time.Second

func waitLimiterTest(t *testing.T, ch <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-ch:
	case <-time.After(limiterTestTimeout):
		t.Fatalf("timed out waiting for %s", what)
	}
}

func waitLimiterCondition(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(limiterTestTimeout)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestResizableLimiterNormalizesLimit(t *testing.T) {
	for _, tc := range []struct {
		in, want int
	}{{in: -3, want: 1}, {in: 0, want: 1}, {in: 1, want: 1}, {in: 8, want: 8}} {
		t.Run(fmt.Sprint(tc.in), func(t *testing.T) {
			l := NewResizableLimiter(tc.in)
			if got := l.Limit(); got != tc.want {
				t.Fatalf("NewResizableLimiter(%d).Limit() = %d, want %d", tc.in, got, tc.want)
			}
			l.SetLimit(tc.in)
			if got := l.Limit(); got != tc.want {
				t.Fatalf("SetLimit(%d) -> Limit() = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

func TestResizableLimiterGrantsInOrderAndCancelReleases(t *testing.T) {
	l := NewResizableLimiter(1)
	if err := l.Acquire(context.Background()); err != nil {
		t.Fatal(err)
	}
	cancelCtx, cancel := context.WithCancel(context.Background())
	canceled := make(chan error, 1)
	go func() { canceled <- l.Acquire(cancelCtx) }()
	waitLimiterCondition(t, "first waiter", func() bool { return l.Waiting() == 1 })
	order := make(chan int, 2)
	var wg sync.WaitGroup
	for i := 1; i <= 2; i++ {
		waiting := l.Waiting()
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if err := l.Acquire(context.Background()); err != nil {
				t.Error(err)
				return
			}
			order <- i
		}(i)
		waitLimiterCondition(t, "queued waiter", func() bool { return l.Waiting() == waiting+1 })
	}

	// A canceled waiter leaves the queue without taking or leaking a slot.
	cancel()
	if err := <-canceled; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled Acquire() = %v, want context.Canceled", err)
	}
	if got := l.Active(); got != 1 {
		t.Fatalf("active after cancel = %d, want 1", got)
	}

	l.Release()
	if got := <-order; got != 1 {
		t.Fatalf("first grant = %d, want 1", got)
	}
	l.Release()
	if got := <-order; got != 2 {
		t.Fatalf("second grant = %d, want 2", got)
	}
	l.Release()
	wg.Wait()
	if got, waiting := l.Active(), l.Waiting(); got != 0 || waiting != 0 {
		t.Fatalf("active=%d waiting=%d, want 0 0", got, waiting)
	}
}

func TestResizableLimiterResize(t *testing.T) {
	l := NewResizableLimiter(2)
	for i := 0; i < 2; i++ {
		if err := l.Acquire(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	acquired := make(chan struct{})
	go func() {
		if err := l.Acquire(context.Background()); err == nil {
			close(acquired)
		}
	}()
	waitLimiterCondition(t, "waiter", func() bool { return l.Waiting() == 1 })

	// Lowering the limit keeps current holders and admits no one until below the new limit.
	l.SetLimit(1)
	l.Release()
	select {
	case <-acquired:
		t.Fatal("waiter admitted while active (1) was not below the lowered limit (1)")
	default:
	}
	l.Release()
	waitLimiterTest(t, acquired, "waiter after holders drained")

	// Raising the limit admits waiters at once.
	more := make(chan struct{})
	go func() {
		if err := l.Acquire(context.Background()); err == nil {
			close(more)
		}
	}()
	waitLimiterCondition(t, "second waiter", func() bool { return l.Waiting() == 1 })
	l.SetLimit(3)
	waitLimiterTest(t, more, "waiter after raising the limit")
	if got := l.Active(); got != 2 {
		t.Fatalf("active = %d, want 2", got)
	}
}

// limiterRunnerProbe records the conversations a runner handles at once.
type limiterRunnerProbe struct {
	mu        sync.Mutex
	active    int
	maxActive int
	perKey    map[string]int
	overlap   []string
	started   []string
	entered   chan string
}

func newLimiterRunnerProbe() *limiterRunnerProbe {
	return &limiterRunnerProbe{perKey: map[string]int{}, entered: make(chan string, 64)}
}

func (p *limiterRunnerProbe) enter(key, value string) {
	p.mu.Lock()
	p.active++
	if p.active > p.maxActive {
		p.maxActive = p.active
	}
	p.perKey[key]++
	if p.perKey[key] > 1 {
		p.overlap = append(p.overlap, key)
	}
	p.started = append(p.started, value)
	p.mu.Unlock()
	p.entered <- value
}

func (p *limiterRunnerProbe) leave(key string) {
	p.mu.Lock()
	p.active--
	p.perKey[key]--
	p.mu.Unlock()
}

func (p *limiterRunnerProbe) snapshot() (maxActive int, overlap []string, started []string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.maxActive, append([]string(nil), p.overlap...), append([]string(nil), p.started...)
}

type limiterRunnerJob struct {
	Value   string
	Release chan struct{}
	Ctx     context.Context
	Panic   bool
}

func newLimiterTestRunner(t *testing.T, limiter ConversationLimiter, probe *limiterRunnerProbe, opts ConversationRunnerOptions[string, limiterRunnerJob]) (*ConversationRunner[string, limiterRunnerJob], context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	opts.Limiter = limiter
	r := NewConversationRunner[string, limiterRunnerJob](ctx, nil, 16, func(_ context.Context, key string, job limiterRunnerJob) {
		probe.enter(key, job.Value)
		defer probe.leave(key)
		if job.Panic {
			panic("limiter test panic")
		}
		jobCtx := job.Ctx
		if jobCtx == nil {
			jobCtx = context.Background()
		}
		select {
		case <-job.Release:
		case <-jobCtx.Done():
		case <-ctx.Done():
		}
	}, opts)
	t.Cleanup(func() {
		cancel()
		r.WaitClosed()
	})
	return r, cancel
}

func enqueueLimiterTestJob(t *testing.T, r *ConversationRunner[string, limiterRunnerJob], key string, job limiterRunnerJob) {
	t.Helper()
	if err := r.Enqueue(context.Background(), key, func(uint64) limiterRunnerJob { return job }); err != nil {
		t.Fatalf("Enqueue(%s): %v", key, err)
	}
}

func expectLimiterEntered(t *testing.T, probe *limiterRunnerProbe, want string) {
	t.Helper()
	select {
	case got := <-probe.entered:
		if got != want {
			t.Fatalf("entered %q, want %q", got, want)
		}
	case <-time.After(limiterTestTimeout):
		t.Fatalf("timed out waiting for %q to start", want)
	}
}

func TestConversationRunnerLimiterLetsOtherConversationProgressPastBlockedOne(t *testing.T) {
	probe := newLimiterRunnerProbe()
	r, _ := newLimiterTestRunner(t, NewResizableLimiter(2), probe, ConversationRunnerOptions[string, limiterRunnerJob]{})
	releaseA := make(chan struct{})
	enqueueLimiterTestJob(t, r, "topic:a", limiterRunnerJob{Value: "a", Release: releaseA})
	expectLimiterEntered(t, probe, "a")
	releaseB := make(chan struct{})
	close(releaseB)
	enqueueLimiterTestJob(t, r, "topic:b", limiterRunnerJob{Value: "b", Release: releaseB})
	// B starts (and finishes) while A is still blocked.
	expectLimiterEntered(t, probe, "b")
	close(releaseA)
}

func TestConversationRunnerLimiterNeverExceedsLimit(t *testing.T) {
	const limit = 3
	const topics = 10
	probe := newLimiterRunnerProbe()
	limiter := NewResizableLimiter(limit)
	r, _ := newLimiterTestRunner(t, limiter, probe, ConversationRunnerOptions[string, limiterRunnerJob]{})
	releases := make(map[string]chan struct{}, topics)
	for i := 0; i < topics; i++ {
		value := fmt.Sprintf("job-%d", i)
		releases[value] = make(chan struct{})
		enqueueLimiterTestJob(t, r, fmt.Sprintf("topic:%d", i), limiterRunnerJob{Value: value, Release: releases[value]})
	}
	running := make([]string, 0, topics)
	for i := 0; i < limit; i++ {
		running = append(running, <-probe.entered)
	}
	waitLimiterCondition(t, "the other topics to wait for a slot", func() bool { return limiter.Waiting() == topics-limit })
	select {
	case extra := <-probe.entered:
		t.Fatalf("%q started while %d topics held all %d slots", extra, limit, limit)
	default:
	}
	finished := 0
	for len(running) > 0 {
		close(releases[running[0]])
		running = running[1:]
		finished++
		if finished+len(running) < topics {
			select {
			case next := <-probe.entered:
				running = append(running, next)
			case <-time.After(limiterTestTimeout):
				t.Fatal("queued topic did not start after a slot was released")
			}
		}
	}
	maxActive, overlap, started := probe.snapshot()
	if maxActive != limit || len(overlap) != 0 || len(started) != topics {
		t.Fatalf("maxActive=%d overlap=%v started=%d, want %d none %d", maxActive, overlap, len(started), limit, topics)
	}
	waitLimiterCondition(t, "all slots released", func() bool { return limiter.Active() == 0 })
}

func TestConversationRunnerLimiterKeepsConversationSerialAndOrdered(t *testing.T) {
	probe := newLimiterRunnerProbe()
	r, _ := newLimiterTestRunner(t, NewResizableLimiter(4), probe, ConversationRunnerOptions[string, limiterRunnerJob]{})
	releases := make([]chan struct{}, 5)
	for i := range releases {
		releases[i] = make(chan struct{})
		enqueueLimiterTestJob(t, r, "topic:same", limiterRunnerJob{Value: fmt.Sprint(i), Release: releases[i]})
	}
	for i := range releases {
		expectLimiterEntered(t, probe, fmt.Sprint(i))
		select {
		case extra := <-probe.entered:
			t.Fatalf("%q started while job %d of the same topic was running", extra, i)
		default:
		}
		close(releases[i])
	}
	waitLimiterCondition(t, "the last job to finish", func() bool {
		probe.mu.Lock()
		defer probe.mu.Unlock()
		return probe.active == 0
	})
	_, overlap, started := probe.snapshot()
	if len(overlap) != 0 || fmt.Sprint(started) != "[0 1 2 3 4]" {
		t.Fatalf("overlap=%v order=%v, want none [0 1 2 3 4]", overlap, started)
	}
}

func TestConversationRunnerLimiterReleasesOnCompletionPanicAndCancel(t *testing.T) {
	probe := newLimiterRunnerProbe()
	limiter := NewResizableLimiter(1)
	panicked := make(chan string, 1)
	r, _ := newLimiterTestRunner(t, limiter, probe, ConversationRunnerOptions[string, limiterRunnerJob]{
		OnPanic: func(_ string, job limiterRunnerJob) { panicked <- job.Value },
	})
	done := make(chan struct{})
	close(done)
	taskCtx, cancelTask := context.WithCancel(context.Background())
	never := make(chan struct{})
	enqueueLimiterTestJob(t, r, "topic:done", limiterRunnerJob{Value: "done", Release: done})
	expectLimiterEntered(t, probe, "done")
	enqueueLimiterTestJob(t, r, "topic:panic", limiterRunnerJob{Value: "panic", Panic: true})
	expectLimiterEntered(t, probe, "panic")
	select {
	case <-panicked:
	case <-time.After(limiterTestTimeout):
		t.Fatal("panic callback not called")
	}
	enqueueLimiterTestJob(t, r, "topic:cancel", limiterRunnerJob{Value: "cancel", Release: never, Ctx: taskCtx})
	expectLimiterEntered(t, probe, "cancel")
	enqueueLimiterTestJob(t, r, "topic:after", limiterRunnerJob{Value: "after", Release: done})
	waitLimiterCondition(t, "queued job to wait", func() bool { return limiter.Waiting() == 1 })
	cancelTask()
	// The queued topic only gets the single slot once the canceled task has released it.
	expectLimiterEntered(t, probe, "after")
	waitLimiterCondition(t, "all slots released", func() bool { return limiter.Active() == 0 })
}

func TestConversationRunnerLimiterResizeKeepsQueuedWork(t *testing.T) {
	probe := newLimiterRunnerProbe()
	limiter := NewResizableLimiter(1)
	r, _ := newLimiterTestRunner(t, limiter, probe, ConversationRunnerOptions[string, limiterRunnerJob]{})
	releaseA := make(chan struct{})
	enqueueLimiterTestJob(t, r, "topic:a", limiterRunnerJob{Value: "a", Release: releaseA})
	expectLimiterEntered(t, probe, "a")
	releaseB := make(chan struct{})
	enqueueLimiterTestJob(t, r, "topic:b", limiterRunnerJob{Value: "b", Release: releaseB})
	waitLimiterCondition(t, "b to wait for a slot", func() bool { return limiter.Waiting() == 1 })
	limiter.SetLimit(2)
	expectLimiterEntered(t, probe, "b")
	close(releaseA)
	close(releaseB)
	waitLimiterCondition(t, "all slots released", func() bool { return limiter.Active() == 0 })
}

func TestConversationRunnerLimiterDropsWaitingJobsOnShutdown(t *testing.T) {
	probe := newLimiterRunnerProbe()
	limiter := NewResizableLimiter(1)
	var dropMu sync.Mutex
	var dropped []string
	r, cancel := newLimiterTestRunner(t, limiter, probe, ConversationRunnerOptions[string, limiterRunnerJob]{
		OnDrop: func(_ string, job limiterRunnerJob) {
			dropMu.Lock()
			dropped = append(dropped, job.Value)
			dropMu.Unlock()
		},
	})
	enqueueLimiterTestJob(t, r, "topic:a", limiterRunnerJob{Value: "a", Release: make(chan struct{})})
	expectLimiterEntered(t, probe, "a")
	enqueueLimiterTestJob(t, r, "topic:b", limiterRunnerJob{Value: "b", Release: make(chan struct{})})
	waitLimiterCondition(t, "b to wait for a slot", func() bool { return limiter.Waiting() == 1 })
	cancel()
	r.WaitClosed()
	dropMu.Lock()
	defer dropMu.Unlock()
	if fmt.Sprint(dropped) != "[b]" {
		t.Fatalf("dropped = %v, want [b]", dropped)
	}
	if active, waiting := limiter.Active(), limiter.Waiting(); active != 0 || waiting != 0 {
		t.Fatalf("active=%d waiting=%d after shutdown, want 0 0", active, waiting)
	}
}
