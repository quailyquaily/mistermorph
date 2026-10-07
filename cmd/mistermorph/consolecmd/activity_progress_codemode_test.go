package consolecmd

import (
	"fmt"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
)

func TestConsoleActivityGroupsCodeModeCalls(t *testing.T) {
	var progress *consoleActivityProgress
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: "cm", ToolName: "codemode", Status: "running"})
	for i := range consoleActivityChildLimit + 3 {
		id := fmt.Sprintf("cm.%d", i)
		progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: id, ParentActivityID: "cm", ToolName: "read_file", Status: "running"})
		progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolDone, ActivityID: id, ParentActivityID: "cm", ToolName: "read_file", Status: "done"})
	}
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolDone, ActivityID: "cm", ToolName: "codemode", Status: "done"})

	if len(progress.History) != 1 {
		t.Fatalf("history = %d entries, want the script as one", len(progress.History))
	}
	script := progress.History[0]
	if script.Name != "codemode" || script.Status != "done" {
		t.Fatalf("script entry = %+v", script)
	}
	if len(script.Children) != consoleActivityChildLimit || script.ChildrenOmitted != 3 {
		t.Fatalf("children = %d, omitted = %d", len(script.Children), script.ChildrenOmitted)
	}
	last := script.Children[len(script.Children)-1]
	if last.ID != fmt.Sprintf("cm.%d", consoleActivityChildLimit+2) || last.Status != "done" {
		t.Fatalf("last child = %+v", last)
	}

	// A call whose parent is no longer in the history shows on its own.
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: "x.0", ParentActivityID: "gone", ToolName: "read_file"})
	if len(progress.History) != 2 {
		t.Fatalf("orphan call not shown: %d entries", len(progress.History))
	}
}
