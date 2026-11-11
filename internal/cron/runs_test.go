package cron

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestRunsListsBoardsRegisteredForTheSamePath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "cron.yaml")
	t0 := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)

	a, b := &RunBoard{}, &RunBoard{}
	unregisterA := RegisterRunBoard(path, a)
	unregisterB := RegisterRunBoard(filepath.Join(dir, ".", "cron.yaml"), b)
	defer unregisterB()

	a.Queue("second", false, t0)
	a.Queue("third", false, t0)
	a.Queue("first", false, t0)
	a.Start("first", "", t0.Add(time.Second), nil)
	b.Queue("other", true, t0.Add(-time.Minute))

	runs := Runs(path)
	want := []struct {
		id    string
		state RunState
	}{{"first", RunRunning}, {"other", RunQueued}, {"second", RunQueued}, {"third", RunQueued}}
	if len(runs) != len(want) {
		t.Fatalf("runs = %+v", runs)
	}
	for i, w := range want {
		if runs[i].ID != w.id || runs[i].State != w.state {
			t.Fatalf("runs[%d] = %+v, want %s %s", i, runs[i], w.id, w.state)
		}
	}
	if !runs[1].Manual || runs[0].StartedAt.IsZero() {
		t.Fatalf("runs = %+v", runs)
	}

	a.Done("first")
	unregisterA()
	unregisterA()
	if runs := Runs(path); len(runs) != 1 || runs[0].ID != "other" {
		t.Fatalf("runs after unregister = %+v", runs)
	}
	if runs := Runs(filepath.Join(dir, "elsewhere.yaml")); len(runs) != 0 {
		t.Fatalf("runs for another path = %+v", runs)
	}
	var nilBoard *RunBoard
	nilBoard.Queue("x", false, t0)
	nilBoard.Start("x", "", t0, nil)
	nilBoard.Done("x")
}

func TestRunBoardStopCancelsOnlyThatExecution(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cron.yaml")
	board := &RunBoard{}
	defer RegisterRunBoard(path, board)()
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)

	runID := board.Queue("task", false, t0)
	if runID == "" {
		t.Fatal("Queue returned no run id")
	}
	ctx, cancel := context.WithCancelCause(context.Background())
	defer cancel(nil)
	if !board.Start("task", runID, t0, cancel) {
		t.Fatal("Start refused a run nobody stopped")
	}

	// Another execution's ID (an earlier run of the same task) touches nothing.
	if got := StopRun(path, "task", "run_stale"); got.Status != StopNotFound {
		t.Fatalf("stale stop = %+v, want not_found", got)
	}
	if got := StopRun(path, "other", runID); got.Status != StopNotFound {
		t.Fatalf("stop of another task = %+v, want not_found", got)
	}
	if ctx.Err() != nil {
		t.Fatal("a stop for another execution cancelled this one")
	}

	got := StopRun(path, "task", runID)
	if got.Status != StopStopping || got.Run == nil || !got.Run.Stopping || got.Run.State != RunRunning {
		t.Fatalf("stop = %+v, want stopping", got)
	}
	if !errors.Is(context.Cause(ctx), ErrRunStopped) {
		t.Fatalf("cause = %v, want ErrRunStopped", context.Cause(ctx))
	}
	if runs := Runs(path); len(runs) != 1 || !runs[0].Stopping || runs[0].RunID != runID {
		t.Fatalf("runs while stopping = %+v", runs)
	}
	// Asking again only reports it.
	if again := StopRun(path, "task", runID); again.Status != StopStopping {
		t.Fatalf("second stop = %+v", again)
	}

	board.Finish("task", runID, RunStatusCanceled, t0.Add(time.Second))
	if runs := Runs(path); len(runs) != 0 {
		t.Fatalf("runs after finish = %+v", runs)
	}
	finished := FinishedRuns(path)
	if len(finished) != 1 || finished[0].RunID != runID || finished[0].Status != RunStatusCanceled || !finished[0].Stopping {
		t.Fatalf("finished = %+v", finished)
	}
	if late := StopRun(path, "task", runID); late.Status != RunStatusCanceled || late.Finished == nil {
		t.Fatalf("stop after the end = %+v, want canceled", late)
	}

	// The task's next run has an ID of its own; the old ID does not reach it.
	next := board.Queue("task", true, t0.Add(time.Minute))
	if next == runID {
		t.Fatal("a new run reused the old run id")
	}
	nextCtx, nextCancel := context.WithCancelCause(context.Background())
	defer nextCancel(nil)
	board.Start("task", next, t0.Add(time.Minute), nextCancel)
	if late := StopRun(path, "task", runID); late.Status != RunStatusCanceled {
		t.Fatalf("old id against the new run = %+v", late)
	}
	if nextCtx.Err() != nil {
		t.Fatal("the old run's id stopped the new run")
	}
}

func TestRunBoardCompletionBeforeStopWins(t *testing.T) {
	board := &RunBoard{}
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	runID := board.Queue("task", false, t0)
	board.Start("task", runID, t0, func(error) {})
	board.Finish("task", runID, RunStatusDone, t0)
	if got := board.Stop("task", runID); got.Status != RunStatusDone || got.Finished == nil || got.Finished.Stopping {
		t.Fatalf("stop after completion = %+v, want done", got)
	}
}

func TestRunBoardStopWhileQueuedKeepsItFromStarting(t *testing.T) {
	board := &RunBoard{}
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	runID := board.Queue("task", false, t0)
	if got := board.Stop("task", runID); got.Status != StopStopping || got.Run.State != RunQueued {
		t.Fatalf("stop while queued = %+v", got)
	}
	called := false
	if board.Start("task", runID, t0, func(error) { called = true }) {
		t.Fatal("a stopped queued run started")
	}
	if called {
		t.Fatal("Start called the cancel of a run it refused")
	}
	board.Finish("task", runID, RunStatusCanceled, t0)
	if got := board.Stop("task", runID); got.Status != RunStatusCanceled {
		t.Fatalf("after = %+v", got)
	}
}

func TestRunBoardKeepsABoundedNumberOfFinishedRuns(t *testing.T) {
	board := &RunBoard{}
	t0 := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	first := ""
	for i := 0; i < finishedRunsKept+5; i++ {
		runID := board.Queue("task", false, t0)
		if first == "" {
			first = runID
		}
		board.Start("task", runID, t0, nil)
		board.Finish("task", runID, RunStatusDone, t0.Add(time.Duration(i)*time.Second))
	}
	if n := len(board.listFinished()); n != finishedRunsKept {
		t.Fatalf("finished kept = %d, want %d", n, finishedRunsKept)
	}
	if got := board.Stop("task", first); got.Status != StopNotFound {
		t.Fatalf("oldest run = %+v, want forgotten", got)
	}
	// Dropped tasks leave no record.
	board.Queue("dropped", false, t0)
	board.Done("dropped")
	for _, f := range board.listFinished() {
		if f.ID == "dropped" {
			t.Fatalf("dropped task recorded: %+v", f)
		}
	}
	var nilBoard *RunBoard
	if got := nilBoard.Stop("task", first); got.Status != StopNotFound {
		t.Fatalf("nil board stop = %+v", got)
	}
	nilBoard.Finish("task", first, RunStatusDone, t0)
}
