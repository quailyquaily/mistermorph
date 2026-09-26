package guard

import (
	"context"
	"path/filepath"
	"testing"
)

func TestRequiresForcedApproval(t *testing.T) {
	for name, want := range map[string]bool{"skill_install": true, " Skill_Install ": true, "bash": false, "": false} {
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
