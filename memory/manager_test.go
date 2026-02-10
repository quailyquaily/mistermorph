package memory

import (
	"path/filepath"
	"testing"
)

func TestLongTermPathUsesGlobalIndexFile(t *testing.T) {
	root := t.TempDir()
	mgr := NewManager(root, 7)

	absA, relA := mgr.LongTermPath("tg:@alice")
	absB, relB := mgr.LongTermPath("cli")

	if relA != "index.md" || relB != "index.md" {
		t.Fatalf("LongTermPath() rel mismatch: got %q and %q, want %q", relA, relB, "index.md")
	}

	wantAbs := filepath.Join(root, "index.md")
	if absA != wantAbs || absB != wantAbs {
		t.Fatalf("LongTermPath() abs mismatch: got %q and %q, want %q", absA, absB, wantAbs)
	}
}
