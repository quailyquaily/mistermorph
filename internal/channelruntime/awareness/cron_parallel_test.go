package awareness

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
)

// cronHarness runs a cron loop whose Run blocks each item until the test releases it.
type cronHarness struct {
	t        *testing.T
	path     string
	requests chan CronRequest
	started  chan string
	cancel   context.CancelFunc
	done     chan struct{}

	mu      sync.Mutex
	release map[string]chan struct{}
	logs    *syncBuffer
}

type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func startCronHarness(t *testing.T, limit int, systemTasks []cronstore.Task) *cronHarness {
	t.Helper()
	h := &cronHarness{
		t:        t,
		path:     filepath.Join(t.TempDir(), "cron.yaml"),
		requests: make(chan CronRequest),
		started:  make(chan string, 16),
		done:     make(chan struct{}),
		release:  map[string]chan struct{}{},
		logs:     &syncBuffer{},
	}
	ctx, cancel := context.WithCancel(context.Background())
	h.cancel = cancel
	go func() {
		defer close(h.done)
		RunCronLoop(ctx, CronLoopOptions{
			Logger:         slog.New(slog.NewTextHandler(h.logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
			Path:           h.path,
			SystemTasks:    systemTasks,
			Requests:       h.requests,
			MaxConcurrency: limit,
			Now:            func() time.Time { return time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC) },
			Run: func(ctx context.Context, due cronstore.DueTask) error {
				id := due.Task.ID
				gate := h.gate(id)
				h.started <- id
				select {
				case <-gate:
					return nil
				case <-ctx.Done():
					return ctx.Err()
				}
			},
		})
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-h.done:
		case <-time.After(5 * time.Second):
			t.Error("cron loop did not stop")
		}
	})
	return h
}

func (h *cronHarness) gate(id string) chan struct{} {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.release[id] == nil {
		h.release[id] = make(chan struct{})
	}
	return h.release[id]
}

func (h *cronHarness) finish(id string) {
	h.mu.Lock()
	gate := h.release[id]
	if gate == nil {
		gate = make(chan struct{})
		h.release[id] = gate
	}
	delete(h.release, id)
	h.mu.Unlock()
	close(gate)
}

func (h *cronHarness) trigger(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return TriggerCron(ctx, h.requests, cronstore.Task{ID: id, Cron: "0 10 * * *", Content: "Run " + id + "."})
}

func (h *cronHarness) waitStarted(want string) {
	h.t.Helper()
	select {
	case got := <-h.started:
		if got != want {
			h.t.Fatalf("started %q, want %q", got, want)
		}
	case <-time.After(2 * time.Second):
		h.t.Fatalf("%s did not start", want)
	}
}

func (h *cronHarness) expectNoStart() {
	h.t.Helper()
	select {
	case got := <-h.started:
		h.t.Fatalf("%s started, want it to wait", got)
	case <-time.After(150 * time.Millisecond):
	}
}

func (h *cronHarness) states() map[string]cronstore.RunState {
	out := map[string]cronstore.RunState{}
	for _, run := range cronstore.Runs(h.path) {
		out[run.ID] = run.State
	}
	return out
}

func TestCronLoopRunsItemsInParallelUpToLimit(t *testing.T) {
	h := startCronHarness(t, 2, nil)
	for _, id := range []string{"a", "b", "c", "d"} {
		if err := h.trigger(id); err != nil {
			t.Fatalf("trigger %s: %v", id, err)
		}
	}
	// a and b run at once; c and d wait for a free slot, in order.
	first := map[string]bool{}
	for i := 0; i < 2; i++ {
		select {
		case id := <-h.started:
			first[id] = true
		case <-time.After(2 * time.Second):
			t.Fatalf("only %v started", first)
		}
	}
	if !first["a"] || !first["b"] {
		t.Fatalf("first two started = %v, want a and b", first)
	}
	h.expectNoStart()
	if got := h.states(); got["a"] != cronstore.RunRunning || got["b"] != cronstore.RunRunning || got["c"] != cronstore.RunQueued || got["d"] != cronstore.RunQueued {
		t.Fatalf("states = %v", got)
	}
	if runs := cronstore.Runs(h.path); len(runs) != 4 || runs[2].ID != "c" || runs[3].ID != "d" {
		t.Fatalf("runs order = %+v", runs)
	}

	h.finish("b")
	h.waitStarted("c")
	h.expectNoStart()
	h.finish("a")
	h.waitStarted("d")
	h.finish("c")
	h.finish("d")
	deadline := time.Now().Add(2 * time.Second)
	for len(cronstore.Runs(h.path)) != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("runs left after finishing: %+v", cronstore.Runs(h.path))
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestCronLoopSkipsItemThatIsStillRunningOrQueued(t *testing.T) {
	h := startCronHarness(t, 1, nil)
	if err := h.trigger("long"); err != nil {
		t.Fatal(err)
	}
	h.waitStarted("long")
	if err := h.trigger("long"); !errors.Is(err, daemonruntime.ErrCronBusy) {
		t.Fatalf("second trigger while running: %v, want ErrCronBusy", err)
	}
	if err := h.trigger("next"); err != nil {
		t.Fatal(err)
	}
	if err := h.trigger("next"); !errors.Is(err, daemonruntime.ErrCronBusy) {
		t.Fatalf("second trigger while queued: %v, want ErrCronBusy", err)
	}
	h.finish("long")
	h.waitStarted("next")
	h.expectNoStart()
	h.finish("next")
	// Once finished, the item can run again.
	deadline := time.Now().Add(2 * time.Second)
	for {
		err := h.trigger("long")
		if err == nil {
			break
		}
		if !errors.Is(err, daemonruntime.ErrCronBusy) || time.Now().After(deadline) {
			t.Fatalf("trigger after finish: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.waitStarted("long")
	h.finish("long")
}

func TestCronLoopHeartbeatIsNotHeldUpByTodoItems(t *testing.T) {
	// The tick at start finds the heartbeat due, as it runs every minute.
	h := startCronHarness(t, 1, []cronstore.Task{cronstore.HeartbeatTask("* * * * *")})
	h.waitStarted(cronstore.HeartbeatTaskID)
	h.finish(cronstore.HeartbeatTaskID)

	h2 := startCronHarness(t, 1, []cronstore.Task{cronstore.HeartbeatTask("0 0 1 1 *")})
	if err := h2.trigger("long"); err != nil {
		t.Fatal(err)
	}
	h2.waitStarted("long")
	// With the only TODO slot taken, the heartbeat still runs in its own lane.
	if err := h2.triggerTask(cronstore.HeartbeatTask("0 0 1 1 *")); err != nil {
		t.Fatal(err)
	}
	h2.waitStarted(cronstore.HeartbeatTaskID)
	h2.finish(cronstore.HeartbeatTaskID)
	h2.finish("long")
}

func (h *cronHarness) triggerTask(task cronstore.Task) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return TriggerCron(ctx, h.requests, task)
}

func TestCronLoopShutdownWaitsForRunningAndLogsQueued(t *testing.T) {
	h := startCronHarness(t, 1, nil)
	if err := h.trigger("running"); err != nil {
		t.Fatal(err)
	}
	h.waitStarted("running")
	if err := h.trigger("waiting"); err != nil {
		t.Fatal(err)
	}
	h.cancel()
	select {
	case <-h.done:
	case <-time.After(2 * time.Second):
		t.Fatal("cron loop did not stop")
	}
	logs := h.logs.String()
	if !strings.Contains(logs, "task_id=waiting reason=shutdown") {
		t.Fatalf("queued item was dropped without a log:\n%s", logs)
	}
	if !strings.Contains(logs, "cron_task_error") || !strings.Contains(logs, "task_id=running") {
		t.Fatalf("running item did not end with the cancelled context:\n%s", logs)
	}
	if runs := cronstore.Runs(h.path); len(runs) != 0 {
		t.Fatalf("runs after shutdown = %+v", runs)
	}
	select {
	case id := <-h.started:
		t.Fatalf("%s started during shutdown", id)
	default:
	}
}
