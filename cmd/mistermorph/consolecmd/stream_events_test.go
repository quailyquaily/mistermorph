package consolecmd

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
)

func TestConsoleCoderProgressLineBoundaries(t *testing.T) {
	for _, backend := range []string{"codex", "claude"} {
		for _, guarded := range []bool{false, true} {
			name := backend + "/raw"
			if guarded {
				name = backend + "/guarded"
			}
			t.Run(name, func(t *testing.T) {
				hub := newConsoleStreamHub()
				sink := newConsoleEventPreviewSink(hub, "task", nil, guard.New(guard.Config{Enabled: guarded}, nil, nil))
				defer sink.Close()
				worker := &agent.WorkerMetadata{ID: "worker", Name: "Milo"}
				sink.HandleEvent(context.Background(), agent.Event{
					Kind: agent.EventKindToolStart, ActivityID: "coder", ToolName: "coder", Worker: worker, Status: "running",
				})
				label := "Codex"
				if backend == "claude" {
					label = "Claude Code"
				}
				chunks := []struct{ summary, text, guardedText string }{
					{label + " is starting", label + " is starting\n", label + " is starting\n"},
					{label + " is working", label + " is working\n", label + " is working\n"},
					{label + " is working", label + " is working\n", label + " is working\n"},
					{label + " is working\r\n", label + " is working\r\n", label + " is working\r\n"},
					{"\n[" + backend + "] tool completed\n", "\n  tool detail\n", "\n[" + backend + "] tool completed\n"},
					{"", "", ""},
					{"", "\n", ""},
					{"", "  func main() {\n\tpar", ""},
					{"", "tial()  ", ""},
					{"", "\n}\n", ""},
					{"", " \t", ""},
				}
				want := ""
				for i, chunk := range chunks {
					event := agent.Event{
						Kind: agent.EventKindToolOutput, ActivityID: "coder", ToolName: "coder", Stream: backend,
						Worker: worker, Text: chunk.text, Summary: chunk.summary,
					}
					// Event transport must retain partial chunks and whitespace-only output.
					raw, err := json.Marshal(event)
					if err != nil {
						t.Fatal(err)
					}
					var transported agent.Event
					if err := json.Unmarshal(raw, &transported); err != nil {
						t.Fatal(err)
					}
					sink.HandleEvent(context.Background(), transported)
					if guarded {
						want += chunk.guardedText
					} else {
						want += chunk.text
					}
					if i == 0 {
						continue // Check starting and working together to reproduce the lost boundary.
					}
					frame, _ := hub.Latest("task")
					raw, err = json.Marshal(frame)
					if err != nil {
						t.Fatal(err)
					}
					var decoded consoleStreamFrame
					if err := json.Unmarshal(raw, &decoded); err != nil {
						t.Fatal(err)
					}
					for _, activity := range []*consoleActivityProgress{frame.Activity, decoded.Activity} {
						if activity == nil || activity.Current == nil || len(activity.History) != 1 || len(activity.Workers) != 1 {
							t.Fatalf("chunk %d: missing activity/worker: %+v", i, activity)
						}
						for _, got := range []string{activity.Current.Output, activity.History[0].Output, activity.Workers[0].Output} {
							if got != want {
								t.Fatalf("chunk %d: output = %q, want %q", i, got, want)
							}
						}
					}
				}
			})
		}
	}
}

func TestFormatConsoleToolStartSuppressesPlanCreate(t *testing.T) {
	if got := formatConsoleToolStart(agent.Event{ToolName: "plan_create"}); got != "" {
		t.Fatalf("formatConsoleToolStart(plan_create) = %q, want empty", got)
	}
	if got := formatConsoleToolStart(agent.Event{ToolName: "web_search"}); got != "[web_search] running" {
		t.Fatalf("formatConsoleToolStart(web_search) = %q, want %q", got, "[web_search] running")
	}
}

func TestFormatConsoleToolDoneSuppressesPlanCreateSuccess(t *testing.T) {
	if got := formatConsoleToolDone(agent.Event{ToolName: "plan_create", Status: "done"}); got != "" {
		t.Fatalf("formatConsoleToolDone(plan_create success) = %q, want empty", got)
	}
	if got := formatConsoleToolDone(agent.Event{ToolName: "plan_create", Error: "boom"}); got == "" {
		t.Fatal("formatConsoleToolDone(plan_create failure) = empty, want failure preview")
	}
}

func TestFormatConsoleRuntimeStatusShowsContextCompaction(t *testing.T) {
	got := formatConsoleRuntimeStatus(agent.Event{Kind: agent.EventKindContextCompactionDone})
	if got != "Context compacted. Continuing with the current task." {
		t.Fatalf("formatConsoleRuntimeStatus() = %q", got)
	}
	if got := formatConsoleRuntimeStatus(agent.Event{Kind: agent.EventKindContextCompactionFailed}); got != "" {
		t.Fatalf("failed compaction status = %q, want empty", got)
	}
}
