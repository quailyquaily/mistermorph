package agent

import (
	"context"
	"errors"
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

// previewingTool always asks for approval (its name is a forced-approval tool) and describes or
// refuses a call before the user is asked.
type previewingTool struct {
	approved []bool
	refuse   bool
}

func (t *previewingTool) Name() string            { return "config_set" }
func (t *previewingTool) Description() string     { return "previewing tool" }
func (t *previewingTool) ParameterSchema() string { return "{}" }
func (t *previewingTool) ApprovalPreview(_ context.Context, params map[string]any) (tools.ApprovalPreview, error) {
	if t.refuse {
		return tools.ApprovalPreview{}, errors.New("refused before asking")
	}
	return tools.ApprovalPreview{Summary: "change " + params["path"].(string), Params: map[string]any{"path": params["path"], "new_value": "********"}}, nil
}
func (t *previewingTool) Execute(ctx context.Context, _ map[string]any) (string, error) {
	t.approved = append(t.approved, tools.UserApproved(ctx))
	return "changed", nil
}

func TestApprovalPreviewDescribesTheApprovalAndMarksTheApprovedCall(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	tool := &previewingTool{}
	registry := tools.NewRegistry()
	registry.Register(tool)
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "c1", Name: "config_set", Arguments: map[string]any{"path": "llm.api_key", "value": "sk-secret"}}}},
		finalResponse("done"),
	)
	engine := New(client, registry, Config{MaxSteps: 5}, DefaultPromptSpec(), WithGuard(g))
	pending, _, err := engine.Run(context.Background(), "set it", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	id := pendingApprovalID(t, pending)
	rec, _, _ := g.GetApproval(context.Background(), id)
	if rec.ActionSummaryRedacted != "change llm.api_key" {
		t.Fatalf("summary = %q", rec.ActionSummaryRedacted)
	}
	call, ok := PendingApprovalToolFromResumeState(rec.ResumeState)
	if !ok || call.Display["new_value"] != "********" || call.Params["value"] != "sk-secret" {
		t.Fatalf("pending call = %+v", call)
	}
	if err := g.ResolveApproval(context.Background(), id, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatal(err)
	}
	if _, _, err := engine.Resume(context.Background(), id); err != nil {
		t.Fatalf("Resume() error = %v", err)
	}
	if len(tool.approved) != 1 || !tool.approved[0] {
		t.Fatalf("executions = %v, want one approved call", tool.approved)
	}
}

func TestApprovalPreviewRefusalAsksNothing(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	tool := &previewingTool{refuse: true}
	registry := tools.NewRegistry()
	registry.Register(tool)
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "c1", Name: "config_set", Arguments: map[string]any{"path": "guard.enabled"}}}},
		finalResponse("refused"),
	)
	final, _, err := New(client, registry, Config{MaxSteps: 5}, DefaultPromptSpec(), WithGuard(g)).Run(context.Background(), "set it", RunOptions{})
	if err != nil || final == nil || final.Output != "refused" || len(tool.approved) != 0 {
		t.Fatalf("Run() = %#v, %v; executions %v", final, err, tool.approved)
	}
}

func TestConfigSetValueIsWithheldFromDisplays(t *testing.T) {
	params := map[string]any{"path": "llm.api_key", "value": "sk-secret"}
	shown := RedactToolParamsForDisplay("config_set", params)
	if shown["value"] == "sk-secret" || shown["path"] != "llm.api_key" || params["value"] != "sk-secret" {
		t.Fatalf("shown = %v, params = %v", shown, params)
	}
	again := RedactToolParamsForDisplay("config_set", shown)
	if again["value"] != shown["value"] {
		t.Fatalf("redaction is not idempotent: %v", again)
	}
	if args := toolDisplayArgsSummary("config_set", params, LogOptions{}); args["value"] == "sk-secret" {
		t.Fatalf("tool event args = %v", args)
	}
}
