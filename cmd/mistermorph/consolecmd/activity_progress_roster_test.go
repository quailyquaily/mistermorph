package consolecmd

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

func TestActivityRosterListsEveryWorkerWithStateOutputAndProcesses(t *testing.T) {
	milo := &agent.WorkerMetadata{ID: "worker-1", Name: "Milo"}
	nova := &agent.WorkerMetadata{ID: "worker-2", Name: "Nova"}
	var progress *consoleActivityProgress
	apply := func(events ...agent.Event) {
		t.Helper()
		for _, event := range events {
			progress, _ = updateConsoleActivityProgress(progress, event)
		}
	}
	apply(
		agent.Event{Kind: agent.EventKindToolStart, ActivityID: "spawn-1", ToolName: "spawn", Status: "running", Worker: milo},
		agent.Event{Kind: agent.EventKindSubtaskStart, TaskID: "sub-1", Status: "running", Worker: milo},
		// A subagent's own tool call carries its worker but does not add one.
		agent.Event{Kind: agent.EventKindToolStart, ActivityID: "read", ToolName: "read_file", Status: "running", Worker: milo},
		agent.Event{Kind: agent.EventKindToolStart, ActivityID: "coder-1", ToolName: "coder", Status: "running", Worker: nova},
		agent.Event{Kind: agent.EventKindToolOutput, ActivityID: "coder-1", ToolName: "coder", Stream: "codex", Text: "step one\n", Worker: nova},
		agent.Event{Kind: agent.EventKindWorkerProcess, Worker: &agent.WorkerMetadata{ID: "worker-2", Name: "Nova", Processes: []agent.WorkerProcess{{PID: 4242, Program: "codex", ActivityID: "coder-1"}}}},
		agent.Event{Kind: agent.EventKindToolOutput, ActivityID: "coder-1", ToolName: "coder", Stream: "codex", Text: "step two\n", Worker: nova},
		agent.Event{Kind: agent.EventKindSubtaskDone, TaskID: "sub-1", Status: "failed", Error: "subagent gave up", Worker: milo},
	)
	if len(progress.Workers) != 2 {
		t.Fatalf("workers = %+v", progress.Workers)
	}
	first, second := progress.Workers[0], progress.Workers[1]
	if first.ID != "worker-1" || first.Name != "Milo" || first.Kind != "subagent" || first.Status != "failed" || first.Error != "subagent gave up" || first.ActivityID != "spawn-1" {
		t.Fatalf("subagent = %+v", first)
	}
	if second.Kind != "coder" || second.Status != "running" || second.Stream != "codex" || second.Output != "step one\nstep two\n" || second.ActivityID != "coder-1" {
		t.Fatalf("coder = %+v", second)
	}
	if len(second.Processes) != 1 || second.Processes[0].PID != 4242 || second.Processes[0].Program != "codex" {
		t.Fatalf("coder processes = %+v", second.Processes)
	}

	// Enough later calls push both workers' entries out of the history.
	for i := 0; i < consoleActivityHistoryLimit+4; i++ {
		apply(agent.Event{Kind: agent.EventKindToolStart, ActivityID: fmt.Sprintf("call-%d", i), ToolName: "read_file", Status: "done"})
	}
	for _, entry := range progress.History {
		if entry.ID == "coder-1" || entry.ID == "spawn-1" {
			t.Fatalf("entry %s still in history", entry.ID)
		}
	}
	// A later process report and a completion without worker metadata still reach the coder.
	apply(
		agent.Event{Kind: agent.EventKindWorkerProcess, Worker: &agent.WorkerMetadata{ID: "worker-2", Name: "Nova", Processes: []agent.WorkerProcess{{PID: 5151, Program: "bash", ActivityID: "coder-1"}}}},
		agent.Event{Kind: agent.EventKindToolDone, ActivityID: "coder-1", ToolName: "coder", Status: "done", Summary: "finished"},
	)
	if len(progress.Workers) != 2 {
		t.Fatalf("workers after trim = %+v", progress.Workers)
	}
	coder := progress.Workers[1]
	if coder.Status != "done" || coder.Summary != "finished" || coder.Output != "step one\nstep two\n" || len(coder.Processes) != 2 {
		t.Fatalf("coder after trim = %+v", coder)
	}

	// The roster survives a save and reload, and a clone does not share processes.
	raw, err := json.Marshal(progress)
	if err != nil {
		t.Fatal(err)
	}
	var loaded consoleActivityProgress
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatal(err)
	}
	if len(loaded.Workers) != 2 || loaded.Workers[1].Processes[1].PID != 5151 || !strings.Contains(string(raw), `"workers":[`) {
		t.Fatalf("reloaded workers = %+v", loaded.Workers)
	}
	clone := cloneConsoleActivityProgress(progress)
	clone.Workers[1].Processes[0].PID = 1
	if progress.Workers[1].Processes[0].PID != 4242 {
		t.Fatal("clone shares worker processes")
	}
}

func TestActivityRosterIsEmptyWithoutWorkersAndBounded(t *testing.T) {
	var progress *consoleActivityProgress
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: "read", ToolName: "read_file", Status: "running"})
	// A spawn from before worker metadata existed does not invent a worker.
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: "old", ToolName: "spawn", Status: "done"})
	if len(progress.Workers) != 0 {
		t.Fatalf("workers = %+v", progress.Workers)
	}
	raw, _ := json.Marshal(progress)
	if strings.Contains(string(raw), "workers") {
		t.Fatalf("empty roster serialized: %s", raw)
	}
	if got, _ := updateConsoleActivityProgress(nil, agent.Event{Kind: agent.EventKindToolOutput, ToolName: "coder", Text: "x"}); got != nil {
		t.Fatalf("output without a call = %+v", got)
	}

	// The oldest workers go once the roster is full, and are counted.
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: "code", ToolName: "codemode", Status: "running"})
	for i := 0; i < consoleActivityWorkerLimit+3; i++ {
		worker := &agent.WorkerMetadata{ID: fmt.Sprintf("worker-%d", i), Name: fmt.Sprintf("W%d", i)}
		progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: fmt.Sprintf("coder-%d", i), ParentActivityID: "code", ToolName: "coder", Status: "running", Worker: worker})
		progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: fmt.Sprintf("plain-%d", i), ToolName: "read_file", Status: "done"})
	}
	if len(progress.Workers) != consoleActivityWorkerLimit || progress.Workers[0].ID != "worker-3" || progress.WorkersOmitted != 3 {
		t.Fatalf("bounded roster: %d workers, first %s, omitted %d", len(progress.Workers), progress.Workers[0].ID, progress.WorkersOmitted)
	}
	// A dropped worker's entry seen again does not add it back.
	progress.History = append(progress.History, consoleActivityEntry{ID: "coder-0", Kind: "tool", Name: "coder", Status: "done", Worker: &agent.WorkerMetadata{ID: "worker-0", Name: "W0"}})
	if syncConsoleActivityWorkers(progress, nil); progress.Workers[0].ID != "worker-3" || len(progress.Workers) != consoleActivityWorkerLimit {
		t.Fatalf("dropped worker came back: first %s, %d workers", progress.Workers[0].ID, len(progress.Workers))
	}
}

func subtaskEnvelope(t *testing.T, result agent.SubtaskResult) string {
	t.Helper()
	raw, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// Review finding: a subagent's final output was lost; only the first line of its summary stayed.
func TestActivityRosterKeepsSubagentFinalOutput(t *testing.T) {
	cases := []struct {
		name   string
		result agent.SubtaskResult
		want   string
	}{
		{"text", agent.SubtaskResult{Status: "done", Summary: "first line", OutputKind: "text", Output: "first line\nsecond line: answer 42"}, "first line\nsecond line: answer 42"},
		{"json", agent.SubtaskResult{Status: "done", Summary: "structured output", OutputKind: "json", Output: map[string]any{"answer": 42}}, "{\n  \"answer\": 42\n}"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			worker := &agent.WorkerMetadata{ID: "worker-1", Name: "Milo"}
			var progress *consoleActivityProgress
			for _, event := range []agent.Event{
				{Kind: agent.EventKindToolStart, ActivityID: "spawn-1", ToolName: "spawn", Status: "running", Worker: worker},
				{Kind: agent.EventKindSubtaskStart, TaskID: "sub-1", Status: "running", Worker: worker},
				{Kind: agent.EventKindSubtaskDone, TaskID: "sub-1", Status: "done", Summary: tc.result.Summary, Worker: worker},
				{Kind: agent.EventKindToolDone, ActivityID: "spawn-1", ToolName: "spawn", Status: "done", Text: subtaskEnvelope(t, tc.result), Worker: worker},
			} {
				progress, _ = updateConsoleActivityProgress(progress, event)
			}
			raw, _ := json.Marshal(progress)
			var loaded consoleActivityProgress
			if err := json.Unmarshal(raw, &loaded); err != nil {
				t.Fatal(err)
			}
			if got := loaded.Workers[0].Result; got != tc.want {
				t.Fatalf("result after reload = %q, want %q", got, tc.want)
			}
		})
	}
}

// Review finding: the spawn call's own success overwrote a failed subagent once history trimmed.
func TestActivityRosterKeepsSubagentFailureOverSpawnSuccess(t *testing.T) {
	failure := agent.SubtaskResult{Status: "failed", Summary: "model failed", Error: "model failed"}
	for _, tc := range []struct {
		name string
		text string
	}{
		{"result envelope", subtaskEnvelope(t, failure)},
		// With Guard on, the Console keeps only the result's status.
		{"status only", consoleResultStatusOnly(subtaskEnvelope(t, failure))},
		// Without a readable result, the subtask's status still outranks the call's.
		{"no result", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			worker := &agent.WorkerMetadata{ID: "worker-1", Name: "Milo"}
			var progress *consoleActivityProgress
			apply := func(event agent.Event) { progress, _ = updateConsoleActivityProgress(progress, event) }
			apply(agent.Event{Kind: agent.EventKindToolStart, ActivityID: "spawn-1", ToolName: "spawn", Status: "running", Worker: worker})
			apply(agent.Event{Kind: agent.EventKindSubtaskStart, TaskID: "sub-1", Status: "running", Worker: worker})
			for i := 0; i < 25; i++ {
				apply(agent.Event{Kind: agent.EventKindToolStart, ActivityID: fmt.Sprintf("read-%d", i), ToolName: "read_file", Status: "done", Worker: worker})
			}
			apply(agent.Event{Kind: agent.EventKindSubtaskDone, TaskID: "sub-1", Status: "failed", Error: "model failed", Worker: worker})
			apply(agent.Event{Kind: agent.EventKindToolDone, ActivityID: "spawn-1", ToolName: "spawn", Status: "done", Text: tc.text, Worker: worker})
			// Later events sync the roster again from the call's entry, which says done.
			apply(agent.Event{Kind: agent.EventKindToolStart, ActivityID: "after", ToolName: "read_file", Status: "done"})
			if got := progress.Workers[0]; got.Status != "failed" || got.Error != "model failed" {
				t.Fatalf("worker = %+v", got)
			}
		})
	}
	if got := consoleResultStatusOnly(subtaskEnvelope(t, agent.SubtaskResult{Status: "done", Output: "secret=abcdefghijklmnop"})); got != `{"status":"done"}` {
		t.Fatalf("status only = %q", got)
	}
	if got := consoleResultStatusOnly("plain observation"); got != "" {
		t.Fatalf("status only of non-result = %q", got)
	}
}

// Review finding: once a codemode entry left the history, later coders lost their output.
func TestActivityRosterKeepsCoderOutputAfterItsEntryIsTrimmed(t *testing.T) {
	var progress *consoleActivityProgress
	apply := func(event agent.Event) { progress, _ = updateConsoleActivityProgress(progress, event) }
	apply(agent.Event{Kind: agent.EventKindToolStart, ActivityID: "code", ToolName: "codemode", Status: "running"})
	for i := 1; i <= 24; i++ {
		worker := &agent.WorkerMetadata{ID: fmt.Sprintf("worker-%d", i), Name: fmt.Sprintf("W%d", i)}
		id := fmt.Sprintf("coder-%d", i)
		apply(agent.Event{Kind: agent.EventKindToolStart, ActivityID: id, ParentActivityID: "code", ToolName: "coder", Status: "running", Worker: worker})
		apply(agent.Event{Kind: agent.EventKindToolOutput, ActivityID: id, ParentActivityID: "code", ToolName: "coder", Stream: "codex", Text: fmt.Sprintf("output %d\n", i), Worker: worker})
		apply(agent.Event{Kind: agent.EventKindToolDone, ActivityID: id, ParentActivityID: "code", ToolName: "coder", Status: "done", Worker: worker,
			Text: subtaskEnvelope(t, agent.SubtaskResult{Status: "done", OutputKind: "text", Output: fmt.Sprintf("answer %d", i)})})
		// Unrelated calls push the codemode entry out of the history.
		apply(agent.Event{Kind: agent.EventKindToolStart, ActivityID: fmt.Sprintf("read-%d", i), ToolName: "read_file", Status: "done"})
	}
	for _, entry := range progress.History {
		if entry.ID == "code" {
			t.Fatal("codemode entry is still in the history")
		}
	}
	if len(progress.Workers) != 24 {
		t.Fatalf("workers = %d", len(progress.Workers))
	}
	for i, worker := range progress.Workers {
		n := i + 1
		if worker.Output != fmt.Sprintf("output %d\n", n) || worker.Result != fmt.Sprintf("answer %d", n) || worker.Status != "done" {
			t.Fatalf("worker %d = %+v", n, worker)
		}
	}
}
