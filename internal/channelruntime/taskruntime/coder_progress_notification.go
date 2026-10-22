package taskruntime

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
)

const (
	// A coder call that finishes within the first delay sends no notice.
	coderProgressFirstDelay = 2 * time.Minute
	coderProgressInterval   = 5 * time.Minute
	// Past this, the notice says how long the CLI has been quiet.
	coderProgressQuietAfter = 2 * time.Minute
)

// CoderProgressNotifyFunc sends text to the conversation a task came from. seq counts the
// coder progress notices of the task from 1, for correlation IDs.
type CoderProgressNotifyFunc func(ctx context.Context, seq int, text string) error

// WithCoderProgressNotification posts a short status while a coder call runs: first after
// two minutes, then every five, until the call finishes or ctx ends.
func WithCoderProgressNotification(ctx context.Context, logger *slog.Logger, notify CoderProgressNotifyFunc) context.Context {
	return withCoderProgressNotification(ctx, logger, notify, coderProgressFirstDelay, coderProgressInterval, time.Now)
}

func withCoderProgressNotification(ctx context.Context, logger *slog.Logger, notify CoderProgressNotifyFunc, firstDelay, interval time.Duration, now func() time.Time) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if notify == nil {
		return ctx
	}
	if logger == nil {
		logger = slog.Default()
	}
	n := &coderProgressNotifier{
		ctx:        ctx,
		logger:     logger,
		notify:     notify,
		firstDelay: firstDelay,
		interval:   interval,
		now:        now,
		runs:       map[string]*coderProgressRun{},
	}
	baseSink, _ := agent.EventSinkFromContext(ctx)
	sink := agent.EventSinkFunc(func(deliveryCtx context.Context, event agent.Event) {
		if baseSink != nil {
			baseSink.HandleEvent(deliveryCtx, event)
		}
		n.handle(event)
	})
	return agent.WithEventSinkContext(ctx, sink)
}

type coderProgressNotifier struct {
	ctx        context.Context
	logger     *slog.Logger
	notify     CoderProgressNotifyFunc
	firstDelay time.Duration
	interval   time.Duration
	now        func() time.Time

	mu   sync.Mutex
	seq  int
	runs map[string]*coderProgressRun
}

// coderProgressRun is one coder call, keyed by the run ID of its subtask.
type coderProgressRun struct {
	backend    string
	started    time.Time
	lastActive time.Time
	step       string
	done       chan struct{}
}

func (n *coderProgressNotifier) handle(event agent.Event) {
	switch strings.TrimSpace(event.Kind) {
	case agent.EventKindToolOutput:
		if event.ToolName != "coder" {
			return
		}
		runID := strings.TrimSpace(event.RunID)
		if runID == "" {
			return
		}
		n.mu.Lock()
		defer n.mu.Unlock()
		at := n.now()
		run, ok := n.runs[runID]
		if !ok {
			run = &coderProgressRun{backend: strings.TrimSpace(event.Stream), started: at, done: make(chan struct{})}
			n.runs[runID] = run
			go n.watch(run)
		}
		run.lastActive = at
		if step := strings.TrimSpace(event.Progress); step != "" {
			run.step = step
		}
	case agent.EventKindSubtaskDone:
		n.mu.Lock()
		defer n.mu.Unlock()
		taskID := strings.TrimSpace(event.TaskID)
		if run, ok := n.runs[taskID]; ok {
			close(run.done)
			delete(n.runs, taskID)
		}
	}
}

func (n *coderProgressNotifier) watch(run *coderProgressRun) {
	timer := time.NewTimer(n.firstDelay)
	defer timer.Stop()
	for {
		select {
		case <-n.ctx.Done():
			return
		case <-run.done:
			return
		case <-timer.C:
		}
		n.mu.Lock()
		select {
		case <-run.done:
			n.mu.Unlock()
			return
		default:
		}
		text := coderProgressText(run, n.now())
		n.seq++
		seq := n.seq
		n.mu.Unlock()
		if err := n.notify(n.ctx, seq, text); err != nil {
			n.logger.Warn("coder_progress_notification_failed", "error", err.Error())
		}
		timer.Reset(n.interval)
	}
}

func coderProgressText(run *coderProgressRun, now time.Time) string {
	name := "The coder"
	switch run.backend {
	case "claude":
		name = "Claude Code"
	case "codex":
		name = "Codex"
	}
	text := fmt.Sprintf("%s is still working (%s so far", name, coderProgressMinutes(now.Sub(run.started)))
	quiet := now.Sub(run.lastActive)
	if quiet >= coderProgressQuietAfter {
		text += fmt.Sprintf("; no new activity for %s", coderProgressMinutes(quiet))
	}
	text += ")."
	if run.step != "" {
		if quiet >= coderProgressQuietAfter {
			text += " Last step: " + run.step + "."
		} else {
			text += " Now: " + run.step + "."
		}
	}
	return text
}

func coderProgressMinutes(d time.Duration) string {
	minutes := int(d.Round(time.Minute) / time.Minute)
	if minutes <= 1 {
		return "1 min"
	}
	return fmt.Sprintf("%d min", minutes)
}
