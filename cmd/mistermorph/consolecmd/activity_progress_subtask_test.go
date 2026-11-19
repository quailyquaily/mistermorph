package consolecmd

import (
	"encoding/json"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

// The Console shows a subtask's task_id from every activity snapshot the recorder publishes while
// its coder runs. Once a subtask has started, each later snapshot (coder output, process records,
// another coder's events, the completion) must carry that subtask's own task_id, and no other.
func TestActivitySubtaskTaskIDStableAcrossPartialUpdates(t *testing.T) {
	milo := &agent.WorkerMetadata{ID: "worker-1", Name: "Milo"}
	ada := &agent.WorkerMetadata{ID: "worker-2", Name: "Ada"}
	events := []agent.Event{
		{Kind: agent.EventKindToolStart, ActivityID: "call-a", ToolName: "coder", Status: "running", Worker: milo},
		// Two coders run at once: their subtasks start, and their events interleave.
		{Kind: agent.EventKindSubtaskStart, TaskID: "sub_a", Mode: "direct", Status: "running", Worker: milo},
		{Kind: agent.EventKindToolStart, ActivityID: "call-b", ToolName: "coder", Status: "running", Worker: ada},
		{Kind: agent.EventKindSubtaskStart, ActivityID: "sub_b", TaskID: "sub_b", Mode: "direct", Status: "running", Worker: ada},
		{Kind: agent.EventKindToolOutput, ActivityID: "call-a", ToolName: "coder", Stream: "codex", Text: "reading\n", Summary: "reading", Status: "running", Worker: milo},
		{Kind: agent.EventKindWorkerProcess, Worker: &agent.WorkerMetadata{ID: milo.ID, Name: milo.Name, Processes: []agent.WorkerProcess{{PID: 11, Program: "codex", ActivityID: "call-a"}}}},
		// An output event without an activity ID goes to the latest running coder call.
		{Kind: agent.EventKindToolOutput, ToolName: "coder", Stream: "claude", Text: "editing\n", Status: "running", Worker: ada},
		{Kind: agent.EventKindToolOutput, ActivityID: "call-a", ToolName: "coder", Stream: "codex", Text: "testing\n", Status: "running", Worker: milo},
		// The completions say no more than their status.
		{Kind: agent.EventKindSubtaskDone, TaskID: "sub_a", Status: "done", OutputKind: "text", Worker: milo},
		{Kind: agent.EventKindToolDone, ActivityID: "call-a", ToolName: "coder", Status: "done", Text: `{"status":"done"}`, Worker: milo},
		{Kind: agent.EventKindToolOutput, ActivityID: "call-b", ToolName: "coder", Stream: "claude", Text: "still going\n", Status: "running", Worker: ada},
		{Kind: agent.EventKindSubtaskDone, ActivityID: "sub_b", TaskID: "sub_b", Status: "failed", Error: "exit 1", Worker: ada},
		{Kind: agent.EventKindToolDone, ActivityID: "call-b", ToolName: "coder", Status: "failed", Worker: ada},
	}

	var progress *consoleActivityProgress
	started := map[string]bool{}
	for i, event := range events {
		progress, _ = updateConsoleActivityProgress(progress, event)
		if event.Kind == agent.EventKindSubtaskStart {
			started[event.TaskID] = true
		}
		// What the stream frame carries, as the Console reads it.
		raw, err := json.Marshal(progress)
		if err != nil {
			t.Fatal(err)
		}
		var frame struct {
			History []struct {
				ID     string `json:"id"`
				Kind   string `json:"kind"`
				TaskID string `json:"task_id"`
			} `json:"history"`
		}
		if err := json.Unmarshal(raw, &frame); err != nil {
			t.Fatal(err)
		}
		seen := map[string]bool{}
		for _, entry := range frame.History {
			switch entry.Kind {
			case "subtask":
				if entry.TaskID != entry.ID {
					t.Fatalf("event %d: subtask %q has task_id %q: %s", i, entry.ID, entry.TaskID, raw)
				}
				seen[entry.ID] = true
			case "tool":
				if entry.TaskID != "" {
					t.Fatalf("event %d: coder call %q took task_id %q: %s", i, entry.ID, entry.TaskID, raw)
				}
			}
		}
		for id := range started {
			if !seen[id] {
				t.Fatalf("event %d: subtask %q left the snapshot: %s", i, id, raw)
			}
		}
	}

	want := map[string]string{"call-a": "done", "sub_a": "done", "call-b": "failed", "sub_b": "failed"}
	for _, entry := range progress.History {
		if status, ok := want[entry.ID]; !ok || entry.Status != status {
			t.Fatalf("entry %q: status %q, want %q", entry.ID, entry.Status, status)
		}
	}
	if progress.History[1].OutputKind != "text" || progress.History[3].Error != "exit 1" {
		t.Fatalf("completion details lost: %+v", progress.History)
	}

	// A new task's recorder starts empty: the next coder call carries no earlier task_id.
	next, _ := updateConsoleActivityProgress(nil, agent.Event{Kind: agent.EventKindToolStart, ActivityID: "call-c", ToolName: "coder", Status: "running"})
	if len(next.History) != 1 || next.History[0].TaskID != "" || next.Current.TaskID != "" {
		t.Fatalf("new progress inherited state: %+v", next)
	}
}
