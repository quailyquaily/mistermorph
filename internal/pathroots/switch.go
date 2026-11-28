package pathroots

import (
	"context"
	"path/filepath"
	"sync"
)

// WorkspaceSwitch is the workspace of one run that may change while it runs (workspace_use): the
// workspace the run started in (its topic's) and the one it uses now. Tools read the current one
// through WorkspaceDirFromContext, so a switch moves read_file, write_file, the shells and every
// other tool that resolves paths from the context. A switch asks for no approval of its own: the
// tools work in the current workspace as they would in the topic's, under the same Guard and tool
// policies. Nothing here is stored: the topic's attachment does not change.
type WorkspaceSwitch struct {
	mu       sync.Mutex
	original string
	current  string
}

// WorkspaceSwitchState is what a paused run keeps of its switch, so a run resumed after an
// approval goes on in the same workspace.
//
// Versions before FT196 also kept "approved", the workspaces the user had approved writes and
// commands in. That field is no longer read: a resume state that has it decodes as before, and
// the list neither grants nor withholds anything.
type WorkspaceSwitchState struct {
	Current string `json:"current,omitempty"`
}

// NewWorkspaceSwitch starts a run's switch in its own workspace.
func NewWorkspaceSwitch(original string) *WorkspaceSwitch {
	original = normalizeRoot(original)
	return &WorkspaceSwitch{original: original, current: original}
}

// Original is the workspace the run started in.
func (s *WorkspaceSwitch) Original() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.original
}

// Current is the workspace the run uses now.
func (s *WorkspaceSwitch) Current() string {
	if s == nil {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.current
}

// Use makes dir the run's workspace for the rest of the run.
func (s *WorkspaceSwitch) Use(dir string) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = normalizeRoot(dir)
}

// Switched reports whether the run uses a workspace other than the one it started in.
func (s *WorkspaceSwitch) Switched() bool {
	if s == nil {
		return false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return !SameDir(s.current, s.original)
}

// State is the switch as a paused run keeps it; the zero state when the run never switched.
func (s *WorkspaceSwitch) State() WorkspaceSwitchState {
	if s == nil {
		return WorkspaceSwitchState{}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if SameDir(s.current, s.original) {
		return WorkspaceSwitchState{}
	}
	return WorkspaceSwitchState{Current: s.current}
}

// Restore puts back what State returned before a pause. The original workspace stays the one the
// switch was made with.
func (s *WorkspaceSwitch) Restore(state WorkspaceSwitchState) {
	if s == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current := normalizeRoot(state.Current); current != "" {
		s.current = current
	}
}

// WithWorkspaceSwitch makes s the run's workspace: WorkspaceDirFromContext reads its current
// workspace each time it is asked.
func WithWorkspaceSwitch(ctx context.Context, s *WorkspaceSwitch) context.Context {
	if ctx == nil {
		ctx = context.Background()
	}
	if s == nil {
		return ctx
	}
	return context.WithValue(ctx, workspaceDirContextKey{}, s)
}

// WorkspaceSwitchFromContext returns the run's switch, when its workspace is one (and not a fixed
// directory set over it).
func WorkspaceSwitchFromContext(ctx context.Context) (*WorkspaceSwitch, bool) {
	if ctx == nil {
		return nil, false
	}
	s, ok := ctx.Value(workspaceDirContextKey{}).(*WorkspaceSwitch)
	return s, ok && s != nil
}

// SameDir reports whether two workspace paths name the same directory as written (cleaned, with
// ~ expanded); it does not follow symlinks.
func SameDir(a, b string) bool {
	return dirKey(a) == dirKey(b)
}

func dirKey(dir string) string {
	dir = normalizeRoot(dir)
	if dir == "" {
		return ""
	}
	if abs, err := filepath.Abs(dir); err == nil {
		dir = abs
	}
	return filepath.Clean(dir)
}
