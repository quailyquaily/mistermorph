package chatcmd

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chatcommands"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
)

func TestAgentInspectorSeparatesRunsAndRetainsFinalOutput(t *testing.T) {
	store := &chatAgentStore{}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	deadline, _ := ctx.Deadline()
	for _, id := range []string{"sub_first", "sub_second"} {
		store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskStart, RunID: "parent", TaskID: id, Mode: "agent", Text: "task " + id})
		store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindTurnStart, RunID: id, Model: "test-model"})
	}
	store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "parent", ToolName: "bash", Text: "parent output"})
	store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindLLMStart, RunID: "sub_first", Step: 25})
	store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "sub_first", ToolName: "bash", Text: "child output"})
	store.HandleRetry(llmstats.WithRunID(ctx, "sub_second"), llmutil.RetryEvent{Reason: "HTTP 504", Attempt: 1, MaxRetries: 5})
	store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindTurnDone, RunID: "sub_first", Status: "done", Text: "complete child result"})
	store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskDone, RunID: "parent", TaskID: "sub_first", Status: "done", Summary: "short result"})
	rows := store.snapshot()
	if len(rows) != 2 || rows[0].ID != "sub_second" {
		t.Fatalf("running child should sort first: %+v", rows)
	}
	first, err := findChatAgent(rows, "first")
	if err != nil || first.Status != "done" || first.ParentID != "parent" || first.Model != "test-model" || first.Step != 25 || !first.Deadline.Equal(deadline) {
		t.Fatalf("child snapshot=%+v err=%v", first, err)
	}
	var text string
	for _, entry := range first.Entries {
		text += entry.Text
	}
	if !strings.Contains(text, "child output") || !strings.Contains(text, "complete child result") || strings.Contains(text, "parent output") || strings.Contains(text, "HTTP 504") {
		t.Fatalf("mixed or missing child transcript: %q", text)
	}
	// Snapshots must not give readers mutable access to the live record.
	first.Entries[0].Text = "mutated"
	first, _ = findChatAgent(store.snapshot(), "first")
	if first.Entries[0].Text == "mutated" {
		t.Fatal("snapshot aliases live transcript")
	}
}

func TestAgentInspectorTerminalStateIgnoresLateProgress(t *testing.T) {
	for _, tt := range []struct{ reason, want string }{
		{"context_canceled", "canceled"}, {"context_deadline_exceeded", "timed_out"},
	} {
		t.Run(tt.want, func(t *testing.T) {
			store := &chatAgentStore{}
			ctx := context.Background()
			store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskStart, TaskID: "sub_one", Mode: "agent"})
			store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindTurnCanceled, RunID: "sub_one", Reason: tt.reason, Error: tt.want})
			store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskDone, TaskID: "sub_one", Status: "failed", Error: tt.want})
			store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindLLMStart, RunID: "sub_one", Step: 99})
			row := store.snapshot()[0]
			if row.Status != tt.want || row.Finished.IsZero() || row.Step == 99 {
				t.Fatalf("late event overwrote terminal state: %+v", row)
			}
		})
	}
}

func TestAgentInspectorBoundsHistoryAndKeepsRunningAgents(t *testing.T) {
	store := &chatAgentStore{}
	ctx := context.Background()
	store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskStart, TaskID: "sub_active", Mode: "agent"})
	for i := 0; i < chatAgentMaxRecords+5; i++ {
		id := fmt.Sprintf("sub_%d", i)
		store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskStart, TaskID: id, Mode: "agent"})
		store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskDone, TaskID: id, Status: "done"})
	}
	for i := 0; i < chatAgentMaxEntries+5; i++ {
		store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "sub_active", ToolName: "read_file", Text: strings.Repeat("界", chatAgentMaxText)})
	}
	rows := store.snapshot()
	active, err := findChatAgent(rows, "active")
	if err != nil || len(rows) > chatAgentMaxRecords || len(active.Entries) > chatAgentMaxEntries || active.Omitted == 0 {
		t.Fatalf("history not bounded: rows=%d entries=%d omitted=%d err=%v", len(rows), len(active.Entries), active.Omitted, err)
	}
	bytes := 0
	for _, entry := range active.Entries {
		bytes += len(entry.Text) + len(entry.Label)
	}
	if bytes > chatAgentMaxBytes {
		t.Fatalf("transcript bytes=%d", bytes)
	}
	if _, err := findChatAgent(rows, "sub_"); err == nil {
		t.Fatal("ambiguous ID should be rejected")
	}
}

func TestAgentInspectorConcurrentReadersAndWriters(t *testing.T) {
	store := &chatAgentStore{}
	ctx := context.Background()
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			id := fmt.Sprintf("sub_%d", i)
			store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskStart, TaskID: id, Mode: "agent"})
			for n := 0; n < 20; n++ {
				store.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: id, ToolName: "probe", Text: "output"})
				_ = store.snapshot()
			}
		}(i)
	}
	wg.Wait()
	if len(store.snapshot()) != 4 {
		t.Fatal("lost concurrent child records")
	}
}

func TestAgentInspectCommandsDispatchWithoutRunningAgent(t *testing.T) {
	var messages []any
	sess := &chatSession{sendMsg: func(msg any) { messages = append(messages, msg) }}
	reg := chatcommands.NewRegistry()
	registerChatCommands(reg, sess, nil, nil)
	for _, name := range []string{"/agents", "/agent", "/subagents"} {
		if !isChatAgentCommand(name) {
			t.Fatalf("command not recognized: %s", name)
		}
		_, handled, err := reg.Dispatch(context.Background(), name+" e313d0f6")
		if !handled || err != nil {
			t.Fatalf("dispatch %s: handled=%v err=%v", name, handled, err)
		}
	}
	if len(messages) != 3 {
		t.Fatalf("inspection requests=%d", len(messages))
	}
	for _, message := range messages {
		if msg, ok := message.(agentInspectMsg); !ok || msg.prefix != "e313d0f6" {
			t.Fatalf("inspection request=%#v", message)
		}
	}
	if isChatAgentCommand("/init") || isChatAgentCommand("implement feature") {
		t.Fatal("unrelated input recognized as inspection")
	}
}

func TestAgentInspectorExactIDWinsOverAmbiguousPrefixes(t *testing.T) {
	rows := []chatAgentRecord{{ID: "sub_abc1"}, {ID: "sub_abc2"}, {ID: "sub_abc"}}
	row, err := findChatAgent(rows, "sub_abc")
	if err != nil || row.ID != "sub_abc" {
		t.Fatalf("exact match=%q err=%v", row.ID, err)
	}
}
