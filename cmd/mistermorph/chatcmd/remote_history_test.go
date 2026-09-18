package chatcmd

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

func TestRemoteHistoryPreservesStructuredFinalOutput(t *testing.T) {
	for _, final := range []*agent.Final{
		{Output: map[string]any{"count": 2, "items": []string{"first", "second"}}},
		{Reaction: "👀"},
	} {
		rows := remoteHistory(map[string]taskdomain.TaskInfo{"task": {
			ID: "task", Status: taskdomain.TaskDone, Result: map[string]any{"final": final},
		}})
		if len(rows) != 2 || rows[1].text != formatRawChatOutput(final) {
			t.Fatalf("shared history changed the common final output: %+v", rows)
		}
	}
}

func TestRemoteHistorySeparatesOutputFromTaskStatus(t *testing.T) {
	for _, tc := range []struct {
		name, output, approval, err, wantStatus string
		state                                   taskdomain.TaskStatus
	}{
		{name: "done", state: taskdomain.TaskDone, output: "# Answer\n\ndone is part of this reply"},
		{name: "queued", state: taskdomain.TaskQueued},
		{name: "running", state: taskdomain.TaskRunning},
		{name: "pending", state: taskdomain.TaskPending, approval: "approval-fixture", wantStatus: "approval-fixture"},
		{name: "failed", state: taskdomain.TaskFailed, err: "provider unavailable", wantStatus: "provider unavailable"},
		{name: "canceled", state: taskdomain.TaskCanceled, wantStatus: "Canceled"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rows := remoteHistory(map[string]taskdomain.TaskInfo{"task": {
				ID: "task", Task: "question", Status: tc.state,
				ApprovalRequestID: tc.approval, Error: tc.err,
				Result: map[string]any{"final": map[string]any{"output": tc.output}},
			}})
			if len(rows) != 2 || rows[1].text != tc.output {
				t.Fatalf("task metadata changed the assistant output: %+v", rows)
			}
			if tc.wantStatus == "" {
				if rows[1].status != "" {
					t.Fatalf("task lifecycle state leaked into conversation history: %q", rows[1].status)
				}
			} else if !strings.Contains(rows[1].status, tc.wantStatus) {
				t.Fatalf("task status lost required detail: %q", rows[1].status)
			}
		})
	}
}

func TestRemoteHistoryStatusChangesDoNotRepeatOutput(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	m := newSharedChatModel(ctx, nil)
	task := taskdomain.TaskInfo{ID: "task", Task: "question", Status: taskdomain.TaskPending,
		ApprovalRequestID: "first-approval", Result: map[string]any{"final": map[string]any{"output": "existing output"}}}
	m.tasks[task.ID] = task
	m.printHistory(false)
	m.transcriptQueue = nil
	m.transcriptPrinting = false
	task.ApprovalRequestID = "second-approval"
	m.tasks[task.ID] = task
	m.printHistory(false)
	update := strings.Join(m.transcriptQueue, "\n")
	if !strings.Contains(update, "second-approval") || strings.Contains(update, "existing output") || strings.Contains(update, "question") {
		t.Fatalf("status update repeated conversation content or lost approval: %q", update)
	}
	if m.printHistory(false) != nil {
		t.Fatal("unchanged history was printed again")
	}
}

func TestRemoteHistoryRestoresLegacyExecutionDetails(t *testing.T) {
	m := newSharedChatModel(context.Background(), nil)
	defer m.cancel()
	activity := map[string]any{"id": "tool", "kind": "tool", "name": "bash", "status": "done", "args": map[string]any{"cmd": "pwd"}, "output": "legacy-result"}
	m.tasks["task"] = taskdomain.TaskInfo{ID: "task", Task: "question", Status: taskdomain.TaskDone, Result: map[string]any{
		"final":    map[string]any{"output": "answer"},
		"plan":     map[string]any{"steps": []map[string]any{{"step": "legacy-plan", "status": "completed"}}},
		"activity": map[string]any{"history": []any{activity}, "current": activity},
	}}
	m.printHistory(false)
	text := strings.Join(m.transcriptQueue, "\n")
	if strings.Count(text, "legacy-result") != 1 || !strings.Contains(text, "legacy-plan") || !strings.Contains(text, "pwd") || strings.Index(text, "legacy-result") > strings.Index(text, "answer") {
		t.Fatalf("legacy execution details were lost or duplicated: %q", text)
	}
	if m.printHistory(false) != nil {
		t.Fatal("unchanged legacy history printed again")
	}
}
