package agent

import (
	"context"

	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

// A run that switches workspace (workspace_use) works in the new one as it would in its topic's:
// writes and commands there ask nothing for the switch itself, only what the Guard and the
// forced-approval tools ask anywhere. What the engine keeps of a switch is where the run is, so a
// run paused for an approval resumes in the workspace it had switched to.

// restoreWorkspaceSwitch puts back the workspace a paused run had switched to. A context without a
// switch gets one, started in the context's workspace, so the resumed run goes on where it was.
// The workspaces a resume state from an older version lists as approved are not read.
func restoreWorkspaceSwitch(ctx context.Context, state *pathroots.WorkspaceSwitchState) context.Context {
	if state == nil || state.Current == "" {
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
	if state.Current == "" {
		return nil
	}
	return &state
}
