package consolecmd

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

func TestActivityWorkerMetadataAcrossUpdatesAndReload(t *testing.T) {
	worker := &agent.WorkerMetadata{ID: "worker-1", Name: "Milo"}
	var progress *consoleActivityProgress
	events := []agent.Event{
		{Kind: agent.EventKindToolStart, ActivityID: "code", ToolName: "codemode", Status: "running"},
		{Kind: agent.EventKindToolStart, ActivityID: "coder", ParentActivityID: "code", ToolName: "coder", Status: "running", Worker: worker},
		{Kind: agent.EventKindSubtaskStart, TaskID: "sub", Status: "running", Worker: worker},
	}
	for _, event := range events {
		progress, _ = updateConsoleActivityProgress(progress, event)
	}
	original := cloneConsoleActivityProgress(progress)
	processWorker := &agent.WorkerMetadata{ID: worker.ID, Name: worker.Name, Processes: []agent.WorkerProcess{{PID: 123, Program: "codex", ActivityID: "coder"}}}
	progress, changed := updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindWorkerProcess, Worker: processWorker})
	if !changed {
		t.Fatal("process event was ignored")
	}
	if len(original.History[0].Children[0].Worker.Processes) != 0 {
		t.Fatal("previous snapshot changed")
	}
	// An older output snapshot and a completion without metadata must not erase the PID.
	for _, event := range []agent.Event{
		{Kind: agent.EventKindToolOutput, ActivityID: "coder", ToolName: "coder", Text: "working", Worker: worker},
		{Kind: agent.EventKindToolDone, ActivityID: "coder", ParentActivityID: "code", ToolName: "coder", Status: "done"},
		{Kind: agent.EventKindSubtaskDone, TaskID: "sub", Status: "done", Worker: worker},
	} {
		progress, _ = updateConsoleActivityProgress(progress, event)
	}
	second := *processWorker
	second.Processes = []agent.WorkerProcess{{PID: 456, Program: "bash", ActivityID: "command"}}
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindWorkerProcess, Worker: &second})
	raw, err := json.Marshal(progress)
	if err != nil {
		t.Fatal(err)
	}
	var loaded consoleActivityProgress
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatal(err)
	}
	for _, entry := range []consoleActivityEntry{loaded.History[0].Children[0], loaded.History[1], *loaded.Current} {
		if entry.Worker == nil || entry.Worker.Name != "Milo" || len(entry.Worker.Processes) != 2 || entry.Status != "done" {
			t.Fatalf("lost metadata: %+v (%s)", entry, raw)
		}
	}
	if !reflect.DeepEqual(loaded.History[0].Children[0].Worker, loaded.History[1].Worker) {
		t.Fatal("worker metadata differs across entries")
	}
	var legacy consoleActivityProgress
	if err := json.Unmarshal([]byte(`{"history":[{"id":"old","kind":"tool","name":"spawn","status":"done"}]}`), &legacy); err != nil {
		t.Fatal(err)
	}
	if got := cloneConsoleActivityProgress(&legacy); got.Current.Worker != nil {
		t.Fatal("legacy entry fabricated worker metadata")
	}
}
