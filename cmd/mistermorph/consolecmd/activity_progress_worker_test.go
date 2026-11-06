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

// The roster carries each worker's allocated name and avatar indices from its events, through
// updates and a reload; workers recorded before indices existed keep having none.
func TestActivityWorkerIndicesReachRosterAndSurviveReload(t *testing.T) {
	nameIndex, avatarIndex := 37, 0
	coder := &agent.WorkerMetadata{ID: "worker-1", Name: "Nova-2", NameIndex: &nameIndex, AvatarIndex: &avatarIndex}
	legacy := &agent.WorkerMetadata{ID: "worker-2", Name: "Luna"}
	var progress *consoleActivityProgress
	for _, event := range []agent.Event{
		{Kind: agent.EventKindToolStart, ActivityID: "coder", ToolName: "coder", Status: "running", Worker: coder},
		{Kind: agent.EventKindToolStart, ActivityID: "spawn", ToolName: "spawn", Status: "running", Worker: legacy},
		{Kind: agent.EventKindToolOutput, ActivityID: "coder", ToolName: "coder", Text: "working", Worker: coder},
		{Kind: agent.EventKindToolDone, ActivityID: "coder", ToolName: "coder", Status: "done"},
	} {
		progress, _ = updateConsoleActivityProgress(progress, event)
	}
	raw, err := json.Marshal(progress)
	if err != nil {
		t.Fatal(err)
	}
	var loaded consoleActivityProgress
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatal(err)
	}
	if len(loaded.Workers) != 2 {
		t.Fatalf("workers = %+v", loaded.Workers)
	}
	got := loaded.Workers[0]
	if got.ID != "worker-1" || got.Name != "Nova-2" || got.NameIndex == nil || *got.NameIndex != 37 || got.AvatarIndex == nil || *got.AvatarIndex != 0 {
		t.Fatalf("indexed worker = %+v (%s)", got, raw)
	}
	if old := loaded.Workers[1]; old.NameIndex != nil || old.AvatarIndex != nil || old.Name != "Luna" {
		t.Fatalf("legacy worker = %+v", old)
	}
	if entry := loaded.History[0]; entry.Worker == nil || entry.Worker.NameIndex == nil || *entry.Worker.NameIndex != 37 {
		t.Fatalf("history entry lost its worker indices: %+v", entry)
	}
	// Replaying the reloaded history keeps each worker's identity and indices.
	again := cloneConsoleActivityProgress(&loaded)
	syncConsoleActivityWorkers(again, nil)
	for i, worker := range again.Workers {
		want := loaded.Workers[i]
		if worker.ID != want.ID || worker.Name != want.Name || !reflect.DeepEqual(worker.NameIndex, want.NameIndex) || !reflect.DeepEqual(worker.AvatarIndex, want.AvatarIndex) {
			t.Fatalf("replay changed worker %d: %+v", i, worker)
		}
	}
}
