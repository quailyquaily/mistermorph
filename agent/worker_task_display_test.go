package agent

import (
	"context"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// The task a spawn or coder call sends reaches its tool events exactly as the agent wrote it, past
// every display cap, while the worker still runs with the task its tool reads from the call.
func TestWorkerTaskEventsKeepTheExactTask(t *testing.T) {
	spawnTask := "\n  Собери отчёт 📊 по логам.\n" + strings.Repeat("Проверь каждую строку — 每一行 ✓\n", 900) + "  END-SPAWN-✅ \n"
	coderTask := "\t修复解析器 🦀\n" + strings.Repeat("Keep the tests green — Grün ✓\n", 900) + "END-CODER-🧪\n\n"
	for _, task := range []string{spawnTask, coderTask} {
		if len(task) <= 8000 {
			t.Fatalf("test task is %d bytes, want it past the old 8000 cap", len(task))
		}
	}

	reg := tools.NewRegistry()
	if err := reg.Register(stubSubtaskTool{name: "bash"}); err != nil {
		t.Fatal(err)
	}
	var coderReq CoderRequest
	coderRunner := &execDirectSubtaskRunner{}
	if err := reg.Register(newCoderTool(coderToolDeps{
		Runner: coderRunner,
		RunCLI: func(_ context.Context, req CoderRequest, _ func(string)) (string, error) {
			coderReq = req
			return "coded", nil
		},
	})); err != nil {
		t.Fatal(err)
	}
	spawnRunner := &stubSubtaskRunner{result: &SubtaskResult{TaskID: "sub_1", Status: SubtaskStatusDone, OutputKind: SubtaskOutputKindText, Output: "spawned"}}
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "spawn-1", Name: "spawn", Arguments: map[string]any{"task": spawnTask, "tools": []any{"bash"}}}}},
		llm.Result{ToolCalls: []llm.ToolCall{{ID: "coder-1", Name: "coder", Arguments: map[string]any{"task": coderTask, "coder": "codex", "cwd": t.TempDir()}}}},
		finalResponse("done"),
	)
	sink := &recordingEventSink{}
	engine := New(client, reg, Config{DefaultModel: "test-model", MaxSteps: 5}, DefaultPromptSpec(), WithSubtaskRunner(spawnRunner))
	if _, _, err := engine.Run(WithEventSinkContext(context.Background(), sink), "delegate", RunOptions{}); err != nil {
		t.Fatal(err)
	}

	want := map[string]string{"spawn": spawnTask, "coder": coderTask}
	seen := map[string]int{}
	for _, ev := range sink.all() {
		if ev.Kind != EventKindToolStart && ev.Kind != EventKindToolDone {
			continue
		}
		task, ok := want[ev.ToolName]
		if !ok {
			continue
		}
		seen[ev.ToolName+" "+ev.Kind]++
		got, _ := ev.Args["task"].(string)
		if got != task {
			t.Fatalf("%s %s task = %d bytes ending %q, want the exact %d bytes ending %q",
				ev.ToolName, ev.Kind, len(got), tail(got), len(task), tail(task))
		}
	}
	for _, key := range []string{"spawn tool_start", "spawn tool_done", "coder tool_start", "coder tool_done"} {
		if seen[key] != 1 {
			t.Fatalf("saw %d %s events, want 1 (seen %v)", seen[key], key, seen)
		}
	}

	// What the workers ran with is unchanged: each tool's own reading of the task.
	if !spawnRunner.called || spawnRunner.req.Task != strings.TrimSpace(spawnTask) {
		t.Fatalf("subagent ran with %d bytes, want the trimmed task (%d bytes)", len(spawnRunner.req.Task), len(strings.TrimSpace(spawnTask)))
	}
	if coderReq.Task != strings.TrimSpace(coderTask) {
		t.Fatalf("coder ran with %d bytes, want the trimmed task (%d bytes)", len(coderReq.Task), len(strings.TrimSpace(coderTask)))
	}
}

func tail(s string) string {
	if r := []rune(s); len(r) > 12 {
		return string(r[len(r)-12:])
	}
	return s
}
