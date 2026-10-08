package agent

import (
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestConcurrentRunSessionIDsStayIsolated(t *testing.T) {
	client := deadlineTestClient(func(_ context.Context, req llm.Request) (llm.Result, error) {
		// The last message is the task supplied by this run.
		want := req.Messages[len(req.Messages)-1].Content
		if req.SessionID != want {
			return llm.Result{}, fmt.Errorf("session = %q, task = %q", req.SessionID, want)
		}
		return finalResponse("done"), nil
	})
	e := New(client, tools.NewRegistry(), Config{MaxSteps: 1}, DefaultPromptSpec())
	var wg sync.WaitGroup
	for i := range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			id := fmt.Sprintf("session-%d", i)
			if _, _, err := e.Run(context.Background(), id, RunOptions{SessionID: id}); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
}

func TestRunSessionIDAcrossTurnsAndSteps(t *testing.T) {
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "read", Name: "read_file", Arguments: map[string]any{}}}},
		finalResponse("first"), finalResponse("second"), finalResponse("other"), finalResponse("no session"),
	)
	reg := tools.NewRegistry()
	if err := reg.Register(&mockTool{name: "read_file", result: "ok"}); err != nil {
		t.Fatal(err)
	}
	e := New(client, reg, Config{MaxSteps: 3}, DefaultPromptSpec())
	for i, sessionID := range []string{"topic-a", "topic-a", "topic-b", ""} {
		ctx := llmstats.WithRunID(context.Background(), []string{"run-1", "run-2", "run-3", "run-4"}[i])
		if _, _, err := e.Run(ctx, "work", RunOptions{SessionID: sessionID}); err != nil {
			t.Fatal(err)
		}
	}
	calls := client.allCalls()
	want := []string{"topic-a", "topic-a", "topic-a", "topic-b", ""}
	if len(calls) != len(want) {
		t.Fatalf("calls = %d", len(calls))
	}
	for i, call := range calls {
		if call.SessionID != want[i] {
			t.Errorf("call %d session = %q, want %q", i, call.SessionID, want[i])
		}
	}
}

func TestSessionIDSurvivesApprovalResume(t *testing.T) {
	g := approvalGuard(newMemoryApprovalStore(), nil)
	client := newMockClient(llm.Result{ToolCalls: []llm.ToolCall{{ID: "bash-1", Name: "bash", Arguments: map[string]any{"cmd": "echo ok"}}}}, finalResponse("done"))
	reg := tools.NewRegistry()
	if err := reg.Register(&mockTool{name: "bash", result: "ok"}); err != nil {
		t.Fatal(err)
	}
	e := New(client, reg, Config{MaxSteps: 3}, DefaultPromptSpec(), WithGuard(g))
	final, _, err := e.Run(context.Background(), "work", RunOptions{SessionID: "original-session"})
	if err != nil {
		t.Fatal(err)
	}
	id := pendingApprovalID(t, final)
	if err := g.ResolveApproval(context.Background(), id, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatal(err)
	}
	// Reconstruct the engine as a runtime does when resuming a saved approval.
	e = New(client, reg, Config{MaxSteps: 3}, DefaultPromptSpec(), WithGuard(g))
	if _, _, err := e.ResumeWithOptions(context.Background(), id, RunOptions{SessionID: "unrelated-session"}); err != nil {
		t.Fatal(err)
	}
	for _, call := range client.allCalls() {
		if call.SessionID != "original-session" {
			t.Fatalf("session = %q", call.SessionID)
		}
	}
}

func TestLocalSubtaskSessionIDsAreIndependent(t *testing.T) {
	client := newMockClient(finalResponse("one"), finalResponse("two"))
	e := New(client, tools.NewRegistry(), Config{MaxSteps: 1}, DefaultPromptSpec())
	for range 2 {
		result, err := e.subtaskRunner.RunSubtask(context.Background(), SubtaskRequest{Task: "child", Registry: tools.NewRegistry()})
		if err != nil || result.Status != SubtaskStatusDone {
			t.Fatalf("result = %#v, err = %v", result, err)
		}
	}
	calls := client.allCalls()
	if len(calls) != 2 || calls[0].SessionID == "" || calls[1].SessionID == "" || calls[0].SessionID == calls[1].SessionID {
		t.Fatalf("subtask sessions are not independent: %#v", calls)
	}
}
