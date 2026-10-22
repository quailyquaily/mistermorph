package taskruntime

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
)

type coderNoticeRecorder struct {
	mu      sync.Mutex
	seqs    []int
	texts   []string
	arrived chan struct{}
}

func newCoderNoticeRecorder() *coderNoticeRecorder {
	return &coderNoticeRecorder{arrived: make(chan struct{}, 16)}
}

func (r *coderNoticeRecorder) notify(_ context.Context, seq int, text string) error {
	r.mu.Lock()
	r.seqs = append(r.seqs, seq)
	r.texts = append(r.texts, text)
	r.mu.Unlock()
	r.arrived <- struct{}{}
	return nil
}

func (r *coderNoticeRecorder) count() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.texts)
}

func (r *coderNoticeRecorder) wait(t *testing.T) {
	t.Helper()
	select {
	case <-r.arrived:
	case <-time.After(2 * time.Second):
		t.Fatal("no coder progress notice arrived")
	}
}

func coderOutputEvent(runID, step string) agent.Event {
	return agent.Event{Kind: agent.EventKindToolOutput, ToolName: "coder", Stream: "claude", RunID: runID, Progress: step, Status: "running"}
}

func TestCoderProgressNotificationRepeatsUntilDone(t *testing.T) {
	t.Parallel()

	rec := newCoderNoticeRecorder()
	ctx := withCoderProgressNotification(context.Background(), nil, rec.notify, 20*time.Millisecond, 20*time.Millisecond, time.Now)
	agent.EmitEvent(ctx, nil, coderOutputEvent("sub_1", "running a command"))
	rec.wait(t)
	rec.wait(t)

	agent.EmitEvent(ctx, nil, agent.Event{Kind: agent.EventKindSubtaskDone, TaskID: "sub_1", Status: "done"})
	stopped := rec.count()
	time.Sleep(100 * time.Millisecond)
	// A notice already being sent when the call finished may still land.
	if got := rec.count(); got > stopped+1 {
		t.Fatalf("notices kept coming after the coder call finished: %d, then %d", stopped, got)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if rec.seqs[0] != 1 || rec.seqs[1] != 2 {
		t.Fatalf("seqs = %v, want 1, 2, ...", rec.seqs)
	}
	if want := "Claude Code is still working (1 min so far). Now: running a command."; rec.texts[0] != want {
		t.Fatalf("text = %q, want %q", rec.texts[0], want)
	}
}

func TestCoderProgressNotificationSkipsShortRuns(t *testing.T) {
	t.Parallel()

	rec := newCoderNoticeRecorder()
	ctx := withCoderProgressNotification(context.Background(), nil, rec.notify, 50*time.Millisecond, 50*time.Millisecond, time.Now)
	agent.EmitEvent(ctx, nil, coderOutputEvent("sub_1", ""))
	agent.EmitEvent(ctx, nil, agent.Event{Kind: agent.EventKindSubtaskDone, TaskID: "sub_1"})
	time.Sleep(120 * time.Millisecond)
	if got := rec.count(); got != 0 {
		t.Fatalf("notices = %d, want none for a call that finished early", got)
	}
}

func TestCoderProgressNotificationStopsWithContext(t *testing.T) {
	t.Parallel()

	rec := newCoderNoticeRecorder()
	ctx, cancel := context.WithCancel(context.Background())
	ctx = withCoderProgressNotification(ctx, nil, rec.notify, 30*time.Millisecond, 30*time.Millisecond, time.Now)
	agent.EmitEvent(ctx, nil, coderOutputEvent("sub_1", ""))
	cancel()
	time.Sleep(100 * time.Millisecond)
	if got := rec.count(); got != 0 {
		t.Fatalf("notices = %d, want none after the task ended", got)
	}
}

func TestCoderProgressNotificationPassesEventsThroughAndIgnoresOtherTools(t *testing.T) {
	t.Parallel()

	var seen []string
	base := agent.WithEventSinkContext(context.Background(), agent.EventSinkFunc(func(_ context.Context, event agent.Event) {
		seen = append(seen, event.Kind+":"+event.ToolName)
	}))
	rec := newCoderNoticeRecorder()
	ctx := withCoderProgressNotification(base, nil, rec.notify, 20*time.Millisecond, 20*time.Millisecond, time.Now)
	agent.EmitEvent(ctx, nil, agent.Event{Kind: agent.EventKindToolOutput, ToolName: "bash", RunID: "run_1", Text: "x"})
	agent.EmitEvent(ctx, nil, agent.Event{Kind: agent.EventKindToolOutput, ToolName: "coder", Text: "no run id"})
	time.Sleep(80 * time.Millisecond)
	if got := rec.count(); got != 0 {
		t.Fatalf("notices = %d, want none", got)
	}
	if len(seen) != 2 || seen[0] != "tool_output:bash" || seen[1] != "tool_output:coder" {
		t.Fatalf("base sink saw %v", seen)
	}
}

func TestCoderProgressText(t *testing.T) {
	t.Parallel()

	start := time.Date(2026, 10, 18, 10, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		name string
		run  coderProgressRun
		now  time.Time
		want string
	}{
		{
			name: "active claude",
			run:  coderProgressRun{backend: "claude", started: start, lastActive: start.Add(11*time.Minute + 50*time.Second), step: "editing files"},
			now:  start.Add(12 * time.Minute),
			want: "Claude Code is still working (12 min so far). Now: editing files.",
		},
		{
			name: "quiet codex",
			run:  coderProgressRun{backend: "codex", started: start, lastActive: start.Add(3 * time.Minute), step: "running a command"},
			now:  start.Add(9 * time.Minute),
			want: "Codex is still working (9 min so far; no new activity for 6 min). Last step: running a command.",
		},
		{
			name: "no step yet",
			run:  coderProgressRun{backend: "claude", started: start, lastActive: start.Add(time.Minute)},
			now:  start.Add(2 * time.Minute),
			want: "Claude Code is still working (2 min so far).",
		},
		{
			name: "unknown backend",
			run:  coderProgressRun{started: start, lastActive: start.Add(5 * time.Minute)},
			now:  start.Add(5 * time.Minute),
			want: "The coder is still working (5 min so far).",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			if got := coderProgressText(&tc.run, tc.now); got != tc.want {
				t.Fatalf("text = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestCoderProgressNotificationMatchesSubtaskIDs(t *testing.T) {
	t.Parallel()

	rec := newCoderNoticeRecorder()
	ctx := withCoderProgressNotification(context.Background(), nil, rec.notify, 20*time.Millisecond, 20*time.Millisecond, time.Now)
	// The coder tool emits from the subtask context and leaves RunID for EmitEvent to fill.
	taskID, runCtx, _ := agent.PrepareSubtaskContext(ctx, nil)
	agent.EmitEvent(runCtx, nil, agent.Event{Kind: agent.EventKindToolOutput, ToolName: "coder", Stream: "codex", Progress: "editing files"})
	rec.wait(t)
	agent.EmitEventDetached(ctx, nil, agent.Event{Kind: agent.EventKindSubtaskDone, TaskID: taskID})
	stopped := rec.count()
	time.Sleep(100 * time.Millisecond)
	if got := rec.count(); got > stopped+1 {
		t.Fatalf("subtask done did not stop notices: %d, then %d", stopped, got)
	}
}
