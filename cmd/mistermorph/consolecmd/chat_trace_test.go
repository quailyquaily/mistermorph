package consolecmd

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/chattrace"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

func TestConsoleChatTraceKeepsToolsChildrenAndFileChanges(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("before\n"), 0600); err != nil {
		t.Fatal(err)
	}
	trace := newConsoleChatTrace("root", pathroots.New(dir, dir, dir), nil, nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	trace.HandleEvent(ctx, agent.Event{Kind: agent.EventKindSubtaskStart, RunID: "root", TaskID: "child", Text: "inspect"})
	trace.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolStart, RunID: "child", ActivityID: "read", ToolName: "read_file", Args: map[string]any{"path": "note.txt"}})
	trace.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "child", ActivityID: "read", ToolName: "read_file", Text: "before"})
	trace.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolStart, RunID: "root", ActivityID: "write", ToolName: "write_file", Args: map[string]any{"path": "note.txt"}})
	if err := os.WriteFile(path, []byte("after\n"), 0600); err != nil {
		t.Fatal(err)
	}
	trace.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "root", ActivityID: "write", ToolName: "write_file", Args: map[string]any{"path": "note.txt"}, Text: "written"})
	snapshot := trace.Snapshot()
	if len(snapshot.Entries) != 5 {
		t.Fatalf("lost events: %+v", snapshot)
	}
	last := snapshot.Entries[4]
	if last.File == nil || last.File.Before != "before\n" || last.File.After != "after\n" {
		t.Fatalf("lost file diff: %+v", last)
	}
	if snapshot.Entries[0].Deadline.IsZero() {
		t.Fatal("child deadline missing")
	}
	snapshot.Entries[1].Event.Args["path"] = "changed"
	if trace.Snapshot().Entries[1].Event.Args["path"] != "note.txt" {
		t.Fatal("snapshot aliases mutable trace")
	}
	for i := 0; i < 1000; i++ {
		trace.HandleEvent(ctx, agent.Event{Kind: agent.EventKindToolDone, RunID: "root", Text: strings.Repeat("x", 20000)})
	}
	bounded := trace.Snapshot()
	if bounded.Omitted == 0 || len(bounded.Entries) > 512 {
		t.Fatal("trace is not bounded")
	}
}

func TestConsoleChatTraceResumePreservesSequenceAndEarlierEvents(t *testing.T) {
	trace := newConsoleChatTrace("root", pathroots.PathRoots{}, nil, nil)
	trace.Restore(chattrace.Snapshot{Omitted: 3, Entries: []chattrace.Entry{{Seq: 8, Event: agent.Event{Kind: agent.EventKindToolDone, Text: "before approval"}}}})
	trace.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolDone, Text: "after approval"})
	snapshot := trace.Snapshot()
	if len(snapshot.Entries) != 2 || snapshot.Entries[0].Seq != 8 || snapshot.Entries[1].Seq != 9 || snapshot.Omitted != 3 {
		t.Fatalf("resume discarded or replayed events: %+v", snapshot)
	}
}

func TestConsoleChatTraceRedactsFileContentsBeforeEncoding(t *testing.T) {
	dir := t.TempDir()
	g := guard.New(guard.Config{Enabled: true, Redaction: guard.RedactionConfig{Enabled: true, Patterns: []guard.RegexPattern{{Name: "line secret", Re: `(?m)^secret-.*$`}}}}, nil, nil)
	trace := newConsoleChatTrace("root", pathroots.New(dir, dir, dir), g, nil)
	path := filepath.Join(dir, "note.txt")
	if err := os.WriteFile(path, []byte("secret-before\npublic\n"), 0600); err != nil {
		t.Fatal(err)
	}
	event := agent.Event{Kind: agent.EventKindToolStart, RunID: "root", ActivityID: "write", ToolName: "write_file", Args: map[string]any{"path": "note.txt"}}
	trace.HandleEvent(context.Background(), event)
	if err := os.WriteFile(path, []byte("secret-after\npublic\n"), 0600); err != nil {
		t.Fatal(err)
	}
	event.Kind = agent.EventKindToolDone
	trace.HandleEvent(context.Background(), event)
	snapshot := trace.Snapshot()
	change := snapshot.Entries[len(snapshot.Entries)-1].File
	if change == nil || strings.Contains(change.Before+change.After, "secret-") || !strings.Contains(change.After, "public") {
		t.Fatalf("file change bypassed Guard redaction: %+v", change)
	}
}

func TestConsoleChatTraceRedactsStructuredFieldsWithoutLosingEvents(t *testing.T) {
	g := guard.New(guard.Config{Enabled: true, Redaction: guard.RedactionConfig{Enabled: true, Patterns: []guard.RegexPattern{{Name: "line secret", Re: `(?m)^secret-.*$`}}}}, nil, nil)
	trace := newConsoleChatTrace("root", pathroots.PathRoots{}, g, nil)
	args := map[string]any{"nested": []any{map[string]any{"text": "secret-argument\npublic"}}}
	trace.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindSubtaskStart, RunID: "root", TaskID: "child", Text: "secret-task\npublic"})
	trace.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolStart, RunID: "root", ToolName: "bash", Args: args})
	trace.RecordPlan(&agent.Plan{Steps: []agent.PlanStep{{Step: "secret-plan\npublic"}}})
	snapshot := trace.Snapshot()
	raw, _ := json.Marshal(snapshot)
	if len(snapshot.Entries) != 3 || strings.Contains(string(raw), "secret-") || !strings.Contains(string(raw), "public") {
		t.Fatalf("structured trace lost an event or bypassed Guard: %s", raw)
	}
	if args["nested"].([]any)[0].(map[string]any)["text"] != "secret-argument\npublic" {
		t.Fatal("trace redaction mutated tool arguments")
	}
}
