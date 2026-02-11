package memory

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestLoadLongTermSummaryCreatesIndexWhenMissing(t *testing.T) {
	root := t.TempDir()
	mgr := NewManager(root, 7)
	mgr.Now = func() time.Time {
		return time.Date(2026, 2, 11, 9, 30, 0, 0, time.UTC)
	}

	abs, _ := mgr.LongTermPath("tg:@alice")
	if _, err := os.Stat(abs); !os.IsNotExist(err) {
		t.Fatalf("expected long-term index to be missing before load, err=%v", err)
	}

	summary, err := mgr.LoadLongTermSummary("tg:@alice")
	if err != nil {
		t.Fatalf("LoadLongTermSummary() error = %v", err)
	}
	if strings.TrimSpace(summary) != "" {
		t.Fatalf("expected empty summary for empty long-term memory, got %q", summary)
	}

	raw, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", abs, err)
	}
	fm, body, ok := ParseFrontmatter(string(raw))
	if !ok {
		t.Fatalf("expected frontmatter in %s", abs)
	}
	if fm.Tasks != "0/0" {
		t.Fatalf("tasks mismatch: got %q want %q", fm.Tasks, "0/0")
	}
	if !strings.Contains(body, "# Long-Term Memory") {
		t.Fatalf("missing long-term header in body: %q", body)
	}
}

func TestUpdateLongTermCreatesIndexWhenNoPromote(t *testing.T) {
	root := t.TempDir()
	mgr := NewManager(root, 7)
	mgr.Now = func() time.Time {
		return time.Date(2026, 2, 11, 9, 30, 0, 0, time.UTC)
	}

	updated, err := mgr.UpdateLongTerm("tg:@alice", PromoteDraft{})
	if err != nil {
		t.Fatalf("UpdateLongTerm() error = %v", err)
	}
	if updated {
		t.Fatalf("UpdateLongTerm() should report updated=false when promote is empty")
	}

	abs, _ := mgr.LongTermPath("tg:@alice")
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("expected long-term index file to be created, err=%v", err)
	}
}
