package agent

import (
	"context"
	"fmt"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

// workspaceGatedTools write files or run commands in the run's workspace (or start a worker that
// does). After a run switches to a workspace other than its topic's (workspace_use), the first
// call to one of them asks the user, through the approval flow, once per workspace and run.
// Reading needs no approval.
var workspaceGatedTools = map[string]bool{
	"write_file":     true,
	"bash":           true,
	"powershell":     true,
	"coder":          true,
	"spawn":          true,
	"image_generate": true,
	"image_edit":     true,
}

// workspaceApprovalPending returns the workspace a call needs approval in: the one the run
// switched to, while writes and commands there are not approved for the run.
func workspaceApprovalPending(ctx context.Context, toolName string) (string, bool) {
	if !workspaceGatedTools[normalizedToolName(toolName)] {
		return "", false
	}
	sw, ok := pathroots.WorkspaceSwitchFromContext(ctx)
	if !ok {
		return "", false
	}
	return sw.PendingApproval()
}

// withWorkspaceApproval adds the approval a switched workspace needs to the guard's decision on a
// call. A call the guard denies stays denied; one the guard lets through, or already asks about,
// needs approval (one approval covers both). Without an approval store the call is denied.
func (e *Engine) withWorkspaceApproval(ctx context.Context, meta guard.Meta, action guard.Action, gr guard.Result, dir string) (guard.Result, error) {
	if gr.Decision == guard.DecisionDeny {
		return gr, nil
	}
	wr, err := guard.EvaluateWorkspaceSwitch(ctx, e.guard, meta, action, dir)
	if err != nil {
		return gr, err
	}
	if wr.Decision == guard.DecisionDeny {
		return wr, nil
	}
	out := gr
	out.Decision = guard.DecisionRequireApproval
	out.RiskLevel = wr.RiskLevel
	out.Forced = true
	out.Reasons = append(append([]string(nil), gr.Reasons...), wr.Reasons...)
	return out, nil
}

// workspaceApprovalPendingObservation is what a call gets that reached execution while its switched
// workspace still needed approval: a call after workspace_use in the same batch, which was checked
// before the switch.
func workspaceApprovalPendingObservation(toolName, dir string) (string, error) {
	err := fmt.Errorf("%s was not run: writes and commands in %s, the workspace this task switched to, need the user's approval first", toolName, dir)
	return fmt.Sprintf("Error: %s. Call %s again on its own; the user will be asked to approve.", err.Error(), toolName), err
}

// restoreWorkspaceSwitch puts back the workspace a paused run had switched to. A context without a
// switch gets one, started in the context's workspace, so the resumed run goes on where it was.
func restoreWorkspaceSwitch(ctx context.Context, state *pathroots.WorkspaceSwitchState) context.Context {
	if state == nil || (state.Current == "" && len(state.Approved) == 0) {
		return ctx
	}
	sw, ok := pathroots.WorkspaceSwitchFromContext(ctx)
	if !ok {
		original, _ := pathroots.WorkspaceDirFromContext(ctx)
		sw = pathroots.NewWorkspaceSwitch(original)
		ctx = pathroots.WithWorkspaceSwitch(ctx, sw)
	}
	sw.Restore(*state)
	return ctx
}

// workspaceSwitchState is what a pausing run keeps of its switch; nil when it has none to keep.
func workspaceSwitchState(ctx context.Context) *pathroots.WorkspaceSwitchState {
	sw, ok := pathroots.WorkspaceSwitchFromContext(ctx)
	if !ok {
		return nil
	}
	state := sw.State()
	if state.Current == "" && len(state.Approved) == 0 {
		return nil
	}
	return &state
}
