package memory

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestParseLongTermContentGoalItems(t *testing.T) {
	body := `
# Long-Term Memory

## Long-Term Goals / Projects

- [ ] [Created](2026-02-11 09:30) | Project Alpha: Launch the new product line by Q3 2026.
- [x] [Created](2026-02-11 09:30), [Done](2026-02-15 10:00) | Finalize the budget proposal for Project Beta.

## Key Facts

- **Key fact A**: Value A
- **Key fact B**: Value B
`
	content := ParseLongTermContent(body)
	if len(content.Goals) != 2 {
		t.Fatalf("goals count mismatch: got %d want 2", len(content.Goals))
	}
	if content.Goals[0].Done {
		t.Fatalf("first goal should be open: %#v", content.Goals[0])
	}
	if !content.Goals[1].Done || content.Goals[1].DoneAt != "2026-02-15 10:00" {
		t.Fatalf("second goal should be done with DoneAt: %#v", content.Goals[1])
	}
	if len(content.Facts) != 2 {
		t.Fatalf("facts count mismatch: got %d want 2", len(content.Facts))
	}
}

func TestBuildLongTermBodyGoalItems(t *testing.T) {
	content := LongTermContent{
		Goals: []LongTermGoal{
			{Done: false, Created: "2026-02-11 09:30", Content: "Project Alpha: Launch the new product line by Q3 2026."},
			{Done: true, Created: "2026-02-11 09:30", DoneAt: "2026-02-15 10:00", Content: "Finalize the budget proposal for Project Beta."},
		},
		Facts: []KVItem{
			{Title: "Key fact A", Value: "Value A"},
		},
	}
	body := BuildLongTermBody(content)
	if !strings.Contains(body, "- [ ] [Created](2026-02-11 09:30) | Project Alpha: Launch the new product line by Q3 2026.") {
		t.Fatalf("missing open goal line: %q", body)
	}
	if !strings.Contains(body, "- [x] [Created](2026-02-11 09:30), [Done](2026-02-15 10:00) | Finalize the budget proposal for Project Beta.") {
		t.Fatalf("missing done goal line: %q", body)
	}
}

func TestUpdateLongTermWritesTaskProgressFrontmatter(t *testing.T) {
	root := t.TempDir()
	mgr := NewManager(root, 7)
	mgr.Now = func() time.Time {
		return time.Date(2026, 2, 11, 9, 30, 0, 0, time.UTC)
	}
	updated, err := mgr.UpdateLongTerm("tg:@alice", PromoteDraft{
		GoalsProjects: []KVItem{
			{Title: "Project Alpha", Value: "Launch the new product line by Q3 2026."},
		},
	})
	if err != nil {
		t.Fatalf("UpdateLongTerm() error = %v", err)
	}
	if !updated {
		t.Fatalf("UpdateLongTerm() should report updated=true")
	}
	abs, _ := mgr.LongTermPath("any")
	raw, err := os.ReadFile(abs)
	if err != nil {
		t.Fatalf("ReadFile(%s) error = %v", abs, err)
	}
	fm, _, ok := ParseFrontmatter(string(raw))
	if !ok {
		t.Fatalf("expected frontmatter in %s", abs)
	}
	if fm.Tasks != "0/1" {
		t.Fatalf("tasks mismatch: got %q want %q", fm.Tasks, "0/1")
	}
}
