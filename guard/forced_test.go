package guard

import (
	"context"
	"path/filepath"
	"testing"
)

func TestRequiresForcedApproval(t *testing.T) {
	for name, want := range map[string]bool{"skill_install": true, " Skill_Install ": true, "config_set": true, "config_get": false, "bash": false, "": false} {
		if got := RequiresForcedApproval(name); got != want {
			t.Fatalf("RequiresForcedApproval(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestEvaluateForcedWithoutStoreDenies(t *testing.T) {
	res, err := EvaluateForced(context.Background(), nil, Meta{}, Action{Type: ActionToolCallPre, ToolName: "skill_install"})
	if err != nil || res.Decision != DecisionDeny {
		t.Fatalf("EvaluateForced(nil guard) = %+v, %v, want deny", res, err)
	}
	res, _ = EvaluateForced(context.Background(), New(Config{Enabled: true}, nil, nil), Meta{}, Action{Type: ActionToolCallPre, ToolName: "skill_install"})
	if res.Decision != DecisionDeny {
		t.Fatalf("EvaluateForced(no store) = %+v, want deny", res)
	}
}

func TestNewCheckedBuildsApprovalsOnlyGuardWhenDisabled(t *testing.T) {
	g, err := NewChecked(Snapshot{Enabled: false, Dir: filepath.Join(t.TempDir(), "guard")}, nil)
	if err != nil {
		t.Fatalf("NewChecked() error = %v", err)
	}
	defer func() { _ = g.Close() }()
	if g == nil || g.Enabled() || !g.ApprovalsAvailable() {
		t.Fatalf("guard = %#v: want non-nil, disabled, with approvals", g)
	}
	if res, _ := g.Evaluate(context.Background(), Meta{}, Action{Type: ActionToolCallPre, ToolName: "bash"}); res.Decision != DecisionAllow {
		t.Fatalf("disabled guard evaluated bash to %+v, want allow", res)
	}
	if _, ok := g.NetworkPolicyForURLFetch(); ok {
		t.Fatal("disabled guard reported a network policy")
	}
	if out, changed := g.RedactString("token=sk-live-123"); changed || out != "token=sk-live-123" {
		t.Fatal("disabled guard redacted output")
	}

	res, err := EvaluateForced(context.Background(), g, Meta{RunID: "r"}, Action{Type: ActionToolCallPre, ToolName: "skill_install"})
	if err != nil || res.Decision != DecisionRequireApproval {
		t.Fatalf("EvaluateForced() = %+v, %v, want require approval", res, err)
	}
	if _, err := g.RequestApproval(context.Background(), Meta{RunID: "r"}, Action{Type: ActionToolCallPre, ToolName: "skill_install"}, res, "install", nil); err != nil {
		t.Fatalf("RequestApproval(skill_install) on approvals-only guard: %v", err)
	}
	if _, err := g.RequestApproval(context.Background(), Meta{RunID: "r"}, Action{Type: ActionToolCallPre, ToolName: "bash"}, res, "bash", nil); err == nil {
		t.Fatal("RequestApproval(bash) succeeded on a disabled guard")
	}
}

func TestWorkspaceSwitchApprovalIsForced(t *testing.T) {
	dir := t.TempDir()
	store, err := NewFileApprovalStore(filepath.Join(dir, "approvals.json"), filepath.Join(dir, ".locks"))
	if err != nil {
		t.Fatal(err)
	}
	g := New(Config{Enabled: false}, nil, store)
	bash := Action{Type: ActionToolCallPre, ToolName: "bash", ToolParams: map[string]any{"cmd": "make"}}
	res, err := EvaluateWorkspaceSwitch(context.Background(), g, Meta{RunID: "r"}, bash, "/w/other")
	if err != nil || res.Decision != DecisionRequireApproval || !res.Forced || res.Reasons[0] != WorkspaceSwitchReason+": /w/other" {
		t.Fatalf("EvaluateWorkspaceSwitch() = %+v, %v", res, err)
	}
	if _, err := g.RequestForcedApproval(context.Background(), Meta{RunID: "r"}, bash, res, "bash", nil); err != nil {
		t.Fatalf("RequestForcedApproval on an approvals-only guard: %v", err)
	}
	// Only a forced decision opens the store this way.
	if _, err := g.RequestForcedApproval(context.Background(), Meta{RunID: "r"}, bash, Result{Decision: DecisionRequireApproval}, "bash", nil); err == nil {
		t.Fatal("RequestForcedApproval took a decision that was not forced")
	}
	// Without a store, the call is denied rather than allowed.
	res, _ = EvaluateWorkspaceSwitch(context.Background(), nil, Meta{}, bash, "/w/other")
	if res.Decision != DecisionDeny {
		t.Fatalf("no store = %+v", res)
	}
}
