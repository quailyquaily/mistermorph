package cron

import (
	"path/filepath"
	"testing"
	"time"
)

func dueIDs(t *testing.T, store *Store, now time.Time) map[string]bool {
	t.Helper()
	due, taskErrs, err := store.DueLenient(now)
	if err != nil || len(taskErrs) != 0 {
		t.Fatalf("DueLenient: %v %v", err, taskErrs)
	}
	out := map[string]bool{}
	for _, item := range due {
		out[item.Task.ID] = true
	}
	return out
}

func TestStoppedRunKeepsTheTaskAndItsSchedule(t *testing.T) {
	store := NewStore(filepath.Join(t.TempDir(), "cron.yaml"))
	tasks := []Task{
		{ID: "once-stopped", At: "2030-01-02 09:00", TZ: "UTC", Content: "Stopped once"},
		{ID: "once-failed", At: "2030-01-02 09:00", TZ: "UTC", Content: "Failed once"},
		{ID: "recurring", Cron: "* * * * *", TZ: "UTC", Content: "Every minute"},
	}
	if err := store.Write(File{Version: Version, Tasks: tasks}); err != nil {
		t.Fatal(err)
	}
	at := time.Date(2030, 1, 2, 9, 0, 0, 0, time.UTC)
	for id, status := range map[string]string{"once-stopped": RunStatusCanceled, "once-failed": RunStatusFailed, "recurring": RunStatusCanceled} {
		if err := store.RecordRunStart(id, at.Add(5*time.Second)); err != nil {
			t.Fatal(err)
		}
		if err := store.RecordRunResult(id, status); err != nil {
			t.Fatal(err)
		}
	}

	// A minute later: the stopped one-time task is not fired again; a failed one still retries,
	// and the recurring task stopped last minute runs at its next minute.
	due := dueIDs(t, store, at.Add(time.Minute))
	if due["once-stopped"] || !due["once-failed"] || !due["recurring"] {
		t.Fatalf("due = %v", due)
	}

	// Stopping changed nothing in the list: every task is there, enabled, with its schedule.
	file, _, err := store.Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(file.Tasks) != len(tasks) {
		t.Fatalf("tasks = %+v", file.Tasks)
	}
	for i, task := range file.Tasks {
		if task.ID != tasks[i].ID || !TaskEnabled(task) || task.At != tasks[i].At || task.Cron != tasks[i].Cron {
			t.Fatalf("task %d = %+v, want %+v", i, task, tasks[i])
		}
	}
	if file.Tasks[0].LastRunStatus != RunStatusCanceled {
		t.Fatalf("last run status = %q", file.Tasks[0].LastRunStatus)
	}

	// Given a new time, the stopped task runs then.
	file.Tasks[0].At = "2030-01-03 09:00"
	if err := store.Write(file); err != nil {
		t.Fatal(err)
	}
	if due := dueIDs(t, store, at.Add(24*time.Hour)); !due["once-stopped"] {
		t.Fatalf("rescheduled stopped task not due: %v", due)
	}
}
