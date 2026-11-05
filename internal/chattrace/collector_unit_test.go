package chattrace

import (
	"context"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

// A unit repeats output the trace already has from the live events, so it is not recorded, with
// Guard or without: its text is raw.
func TestCollectorLeavesOutputUnitsOut(t *testing.T) {
	for name, g := range map[string]*guard.Guard{"guard off": nil, "guard on": guard.New(guard.Config{Enabled: true}, nil, nil)} {
		var last Snapshot
		c := NewCollector("task", pathroots.PathRoots{}, g, func(s Snapshot) { last = s })
		c.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolOutput, ToolName: "coder", Text: "live piece"})
		before := c.Snapshot()
		c.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolOutputUnit, ToolName: "coder", Text: "token=abcdefghijklmnopqrstuvwx"})
		after := c.Snapshot()
		if len(after.Entries) != len(before.Entries) || len(after.Entries) != 1 {
			t.Fatalf("%s: entries before = %d, after = %d", name, len(before.Entries), len(after.Entries))
		}
		_ = last
	}
}
