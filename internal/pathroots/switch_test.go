package pathroots

import (
	"context"
	"encoding/json"
	"testing"
)

func TestWorkspaceSwitchMovesTheContextWorkspace(t *testing.T) {
	sw := NewWorkspaceSwitch("/work/topic")
	ctx := WithWorkspaceSwitch(context.Background(), sw)
	if dir, ok := WorkspaceDirFromContext(ctx); !ok || dir != "/work/topic" {
		t.Fatalf("before switch = %q, %v", dir, ok)
	}
	if sw.Switched() {
		t.Fatal("switched before any switch")
	}
	sw.Use("/work/other/")
	if dir, _ := WorkspaceDirFromContext(ctx); dir != "/work/other" {
		t.Fatalf("after switch = %q", dir)
	}
	if roots := Resolve(ctx, New("/ignored", "/cache", "/state")); roots.WorkspaceDir != "/work/other" || roots.FileCacheDir != "/cache" {
		t.Fatalf("roots = %+v", roots)
	}

	// A paused run keeps the workspace it switched to; a fresh switch takes it back.
	state := sw.State()
	if state != (WorkspaceSwitchState{Current: "/work/other"}) {
		t.Fatalf("state = %+v", state)
	}
	fresh := NewWorkspaceSwitch("/work/topic")
	fresh.Restore(state)
	if fresh.Current() != "/work/other" || fresh.Original() != "/work/topic" || !fresh.Switched() {
		t.Fatalf("restored = %q from %q", fresh.Current(), fresh.Original())
	}
	// Back home is not a switch, and keeps nothing.
	fresh.Use("/work/topic/")
	if fresh.Switched() || fresh.State() != (WorkspaceSwitchState{}) {
		t.Fatalf("back home: switched=%v state=%+v", fresh.Switched(), fresh.State())
	}

	// A fixed directory set over the switch wins, as for a subtask.
	inner := WithWorkspaceDir(ctx, "/fixed")
	if _, ok := WorkspaceSwitchFromContext(inner); ok {
		t.Fatal("a fixed directory still exposes the switch")
	}
	if dir, _ := WorkspaceDirFromContext(inner); dir != "/fixed" {
		t.Fatalf("fixed = %q", dir)
	}
}

// A state kept by a version that still asked before writes in a switched workspace has the
// workspaces approved then: it decodes, restores the current workspace, and the list changes
// nothing.
func TestLegacyApprovedStateRestoresTheWorkspaceOnly(t *testing.T) {
	var state WorkspaceSwitchState
	if err := json.Unmarshal([]byte(`{"current":"/work/other","approved":["/work/other","/work/third"]}`), &state); err != nil {
		t.Fatalf("decode legacy state: %v", err)
	}
	sw := NewWorkspaceSwitch("/work/topic")
	sw.Restore(state)
	if sw.Current() != "/work/other" || sw.Original() != "/work/topic" {
		t.Fatalf("restored = %q from %q", sw.Current(), sw.Original())
	}
	if got := sw.State(); got != (WorkspaceSwitchState{Current: "/work/other"}) {
		t.Fatalf("state after a legacy restore = %+v", got)
	}
	// An approvals-only legacy state (back in the topic's workspace) restores nothing.
	var back WorkspaceSwitchState
	if err := json.Unmarshal([]byte(`{"approved":["/work/other"]}`), &back); err != nil {
		t.Fatal(err)
	}
	home := NewWorkspaceSwitch("/work/topic")
	home.Restore(back)
	if home.Current() != "/work/topic" || home.Switched() {
		t.Fatalf("approvals-only legacy state moved the run to %q", home.Current())
	}
}

func TestUnswitchedStateIsEmpty(t *testing.T) {
	sw := NewWorkspaceSwitch("/a")
	if state := sw.State(); state.Current != "" {
		t.Fatalf("state = %+v", state)
	}
	var none *WorkspaceSwitch
	if none.Current() != "" || none.Switched() {
		t.Fatal("nil switch")
	}
}
