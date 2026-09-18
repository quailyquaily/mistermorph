package chatcmd

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chattrace"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestSharedTraceRetainsToolOutputAndChildRecordsWithoutDuplicates(t *testing.T) {
	m := newSharedChatModel(context.Background(), nil)
	defer m.cancel()
	now := time.Now().Add(-time.Minute)
	snapshot := chattrace.Snapshot{Entries: []chattrace.Entry{
		{Seq: 1, At: now, Event: agent.Event{Kind: agent.EventKindToolDone, RunID: "root", ToolName: "bash", Args: map[string]any{"cmd": "pwd"}, Text: "tool-result"}},
		{Seq: 2, At: now, Deadline: now.Add(time.Hour), Event: agent.Event{Kind: agent.EventKindSubtaskStart, RunID: "root", TaskID: "child", Text: "inspect"}},
		{Seq: 3, At: now, Event: agent.Event{Kind: agent.EventKindToolDone, RunID: "child", ToolName: "read_file", Text: "child-result"}},
	}}
	output := m.renderSharedTrace("root", snapshot, false)
	if !strings.Contains(output, "tool-result") || strings.Contains(output, "child-result") {
		t.Fatalf("wrong main transcript: %s", output)
	}
	rows := m.agents.snapshot()
	if len(rows) != 1 || !rows[0].Started.Equal(now) || len(rows[0].Entries) != 2 || !strings.Contains(rows[0].Entries[1].Text, "child-result") {
		t.Fatalf("missing child history: %+v", rows)
	}
	if m.renderSharedTrace("root", snapshot, false) != "" {
		t.Fatal("same snapshot repeated tool output")
	}
	m.tasks["root"] = taskdomain.TaskInfo{ID: "root", Task: "question", Status: taskdomain.TaskDone, Result: map[string]any{"trace": snapshot, "final": map[string]any{"output": "answer"}}}
	m.printHistory(true)
	transcript := strings.Join(m.transcriptQueue, "\n")
	if !strings.Contains(transcript, "tool-result") || strings.Index(transcript, "tool-result") > strings.Index(transcript, "answer") {
		t.Fatalf("history lost tool output/order: %s", transcript)
	}
}

func TestSharedTraceFiltersTerminalControlsAndReportsMissingRecords(t *testing.T) {
	m := newSharedChatModel(context.Background(), nil)
	defer m.cancel()
	snapshot := chattrace.Snapshot{Omitted: 2, Entries: []chattrace.Entry{
		{Seq: 1, Event: agent.Event{Kind: agent.EventKindSubtaskStart, RunID: "root", TaskID: "child"}},
		{Seq: 4, Event: agent.Event{Kind: agent.EventKindToolDone, RunID: "root", ToolName: "bash\x1b]52;c;injected\x07", Text: "result"}},
	}}
	output := m.renderSharedTrace("root", snapshot, false)
	if strings.Contains(output, "injected") || strings.Contains(output, "\x07") {
		t.Fatalf("remote tool name contains terminal controls: %q", output)
	}
	if !strings.Contains(output, "omitted") {
		t.Fatalf("missing trace gap notice: %q", output)
	}
	if output := m.renderSharedTrace("root", snapshot, false); output != "" {
		t.Fatalf("repeated snapshot output: %q", output)
	}
}
