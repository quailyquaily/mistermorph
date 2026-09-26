package agent

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// An approvals-only guard: guard.enabled and guard.approvals.enabled are both off, but the
// approval store exists.
func approvalsOnlyGuard(store guard.ApprovalStore) *guard.Guard {
	return guard.New(guard.Config{Enabled: false}, nil, store)
}

func TestSkillInstallAlwaysNeedsApproval(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	var installs, bashCalls int
	registry := tools.NewRegistry()
	registry.Register(&countingTool{name: "skill_install", result: "installed", count: &installs})
	registry.Register(&countingTool{name: "bash", result: "ok", count: &bashCalls})
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "b1", Name: "bash", Arguments: map[string]any{"cmd": "ls"}}}},
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "i1", Name: "skill_install", Arguments: map[string]any{"preview_id": "p1"}}}},
		finalResponse("done"),
	)
	engine := New(client, registry, Config{MaxSteps: 5}, DefaultPromptSpec(), WithGuard(g))

	pending, _, err := engine.Run(context.Background(), "install it", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if bashCalls != 1 {
		t.Fatalf("bash calls = %d, want 1: the guard is off, so ordinary tools run without approval", bashCalls)
	}
	if installs != 0 {
		t.Fatalf("skill_install ran %d times before approval", installs)
	}
	approvalID := pendingApprovalID(t, pending)
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatalf("ResolveApproval() error = %v", err)
	}
	final, _, err := engine.Resume(context.Background(), approvalID)
	if err != nil {
		t.Fatalf("Resume() error = %v", err)
	}
	if final == nil || final.Output != "done" || installs != 1 {
		t.Fatalf("Resume() final = %#v, installs = %d, want done and 1", final, installs)
	}
}

func TestSkillInstallDeniedWithoutApprovalStore(t *testing.T) {
	var installs int
	registry := tools.NewRegistry()
	registry.Register(&countingTool{name: "skill_install", result: "installed", count: &installs})
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "i1", Name: "skill_install", Arguments: map[string]any{"preview_id": "p1"}}}},
		finalResponse("could not install"),
	)
	engine := New(client, registry, Config{MaxSteps: 4}, DefaultPromptSpec())

	final, _, err := engine.Run(context.Background(), "install it", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if installs != 0 {
		t.Fatalf("skill_install ran %d times without any approval store", installs)
	}
	if final == nil || final.Output != "could not install" {
		t.Fatalf("final = %#v", final)
	}
}
