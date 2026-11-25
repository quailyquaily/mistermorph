package pathroots

import (
	"context"
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
	if _, pending := sw.PendingApproval(); pending {
		t.Fatal("the topic's own workspace needs no approval")
	}
	sw.Use("/work/other/")
	if dir, _ := WorkspaceDirFromContext(ctx); dir != "/work/other" {
		t.Fatalf("after switch = %q", dir)
	}
	if roots := Resolve(ctx, New("/ignored", "/cache", "/state")); roots.WorkspaceDir != "/work/other" || roots.FileCacheDir != "/cache" {
		t.Fatalf("roots = %+v", roots)
	}
	if dir, pending := sw.PendingApproval(); !pending || dir != "/work/other" {
		t.Fatalf("pending = %q, %v", dir, pending)
	}
	sw.Approve("/work/other")
	if _, pending := sw.PendingApproval(); pending {
		t.Fatal("approved workspace still pending")
	}

	// A paused run keeps the switch and its approvals; a fresh switch takes them back.
	state := sw.State()
	fresh := NewWorkspaceSwitch("/work/topic")
	fresh.Restore(state)
	if fresh.Current() != "/work/other" || fresh.Original() != "/work/topic" {
		t.Fatalf("restored = %q from %q", fresh.Current(), fresh.Original())
	}
	if _, pending := fresh.PendingApproval(); pending {
		t.Fatal("restored approval lost")
	}
	// Another workspace asks again.
	fresh.Use("/work/third")
	if _, pending := fresh.PendingApproval(); !pending {
		t.Fatal("a third workspace was approved by the second's approval")
	}
	// Back home needs nothing.
	fresh.Use("/work/topic/")
	if _, pending := fresh.PendingApproval(); pending || fresh.Switched() {
		t.Fatal("the topic's own workspace needs approval after switching back")
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

func TestUnswitchedStateIsEmpty(t *testing.T) {
	sw := NewWorkspaceSwitch("/a")
	if state := sw.State(); state.Current != "" || len(state.Approved) != 0 {
		t.Fatalf("state = %+v", state)
	}
	var none *WorkspaceSwitch
	if none.Current() != "" || none.Switched() {
		t.Fatal("nil switch")
	}
}

func TestWorkspaceSwitchAwaitingApproval(t *testing.T) {
	dir := t.TempDir()
	sw := NewWorkspaceSwitchAwaitingApproval(dir)
	if got, pending := sw.PendingApproval(); !pending || got != dir {
		t.Fatalf("PendingApproval = %q, %v; want the run's own workspace pending", got, pending)
	}
	sw.Approve(dir)
	if _, pending := sw.PendingApproval(); pending {
		t.Fatal("pending after approval")
	}
	if sw.Original() != dir || sw.Current() != dir {
		t.Fatalf("original=%q current=%q", sw.Original(), sw.Current())
	}
	// A plain switch's own workspace never asks.
	if _, pending := NewWorkspaceSwitch(dir).PendingApproval(); pending {
		t.Fatal("plain switch pending in its own workspace")
	}
}
