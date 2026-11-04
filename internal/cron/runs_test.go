package cron

import (
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
	a.Start("first", t0.Add(time.Second))
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
	nilBoard.Start("x", t0)
	nilBoard.Done("x")
}
