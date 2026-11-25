package guard

import (
	"context"
	"strings"
)

// forcedApprovalTools always ask the user before they run, whatever guard.enabled and
// guard.approvals.enabled say: their effect is too large to allow silently. Installing a skill
// adds instructions (and possibly scripts) the agent will follow from then on; config_set changes
// the agent's own config.
var forcedApprovalTools = map[string]bool{
	"skill_install": true,
	"config_set":    true,
}

// RequiresForcedApproval reports whether a tool always needs the user's approval.
func RequiresForcedApproval(toolName string) bool {
	return forcedApprovalTools[strings.ToLower(strings.TrimSpace(toolName))]
}

// ApprovalsAvailable reports whether this guard can hold approval requests. It is true for an
// approvals-only guard too (guard.enabled false), so forced-approval tools keep working.
func (g *Guard) ApprovalsAvailable() bool {
	return g != nil && g.approvals != nil
}

// EvaluateForced decides a call to a forced-approval tool: it needs approval when approvals can
// be stored, and is denied otherwise, never allowed outright. It audits like Evaluate.
func EvaluateForced(ctx context.Context, g *Guard, meta Meta, a Action) (Result, error) {
	name := strings.ToLower(strings.TrimSpace(a.ToolName))
	return evaluateAlwaysAsk(ctx, g, meta, a, name+"_requires_approval", name+"_requires_approval_but_approvals_are_unavailable")
}

// WorkspaceSwitchReason starts the reason of an approval that a write or a command needs because
// the run switched to a workspace other than its topic's (workspace_use).
const WorkspaceSwitchReason = "workspace_switch_requires_approval"

// EvaluateWorkspaceSwitch decides a write or a command in a workspace the run switched to, the
// first in that workspace: like a forced-approval tool, it needs approval when approvals can be
// stored and is denied otherwise. It audits like Evaluate.
func EvaluateWorkspaceSwitch(ctx context.Context, g *Guard, meta Meta, a Action, workspaceDir string) (Result, error) {
	dir := strings.TrimSpace(workspaceDir)
	return evaluateAlwaysAsk(ctx, g, meta, a, WorkspaceSwitchReason+": "+dir, WorkspaceSwitchReason+"_but_approvals_are_unavailable: "+dir)
}

func evaluateAlwaysAsk(ctx context.Context, g *Guard, meta Meta, a Action, reason, unavailableReason string) (Result, error) {
	res := Result{
		RiskLevel: RiskHigh,
		Decision:  DecisionRequireApproval,
		Reasons:   []string{reason},
		Forced:    true,
	}
	if !g.ApprovalsAvailable() {
		res.Decision = DecisionDeny
		res.Reasons = []string{unavailableReason}
	}
	if g == nil {
		return res, nil
	}
	if err := g.emitAudit(ctx, meta, a, res, "", "", ""); err != nil {
		return res, err
	}
	return res, nil
}
