package guard

import (
	"context"
	"strings"
)

// forcedApprovalTools always ask the user before they run, whatever guard.enabled and
// guard.approvals.enabled say: their effect is too large to allow silently. Installing a skill
// adds instructions (and possibly scripts) the agent will follow from then on.
var forcedApprovalTools = map[string]bool{
	"skill_install": true,
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
	res := Result{
		RiskLevel: RiskHigh,
		Decision:  DecisionRequireApproval,
		Reasons:   []string{name + "_requires_approval"},
	}
	if !g.ApprovalsAvailable() {
		res.Decision = DecisionDeny
		res.Reasons = []string{name + "_requires_approval_but_approvals_are_unavailable"}
	}
	if g == nil {
		return res, nil
	}
	if err := g.emitAudit(ctx, meta, a, res, "", "", ""); err != nil {
		return res, err
	}
	return res, nil
}
