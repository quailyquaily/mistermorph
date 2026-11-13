package consolecmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/llm"
)

// consoleWorkerTaskTool stands in for spawn or coder: it records the task it was called with and
// returns a finished result envelope.
type consoleWorkerTaskTool struct {
	name string
	mu   *sync.Mutex
	got  map[string]string
}

func (t consoleWorkerTaskTool) Name() string            { return t.name }
func (t consoleWorkerTaskTool) Description() string     { return "test worker" }
func (t consoleWorkerTaskTool) ParameterSchema() string { return `{}` }
func (t consoleWorkerTaskTool) Execute(_ context.Context, params map[string]any) (string, error) {
	task, _ := params["task"].(string)
	t.mu.Lock()
	t.got[t.name] = task
	t.mu.Unlock()
	raw, err := json.Marshal(agent.SubtaskResult{TaskID: "sub_" + t.name, Status: agent.SubtaskStatusDone, OutputKind: agent.SubtaskOutputKindText, Output: "ok"})
	return string(raw), err
}

// What the agent asked a subagent or a coder reaches the Console whole and exact, live and after a
// reload from the journal, in the call's arguments and on its worker; the tools get the call's
// own task.
func TestConsoleWorkerTaskStreamsAndPersistsExactly(t *testing.T) {
	tasks := map[string]string{
		"spawn": "\n  Собери отчёт 📊 по логам.\n" + strings.Repeat("Проверь каждую строку — 每一行 ✓\n", 400) + "  END-SPAWN-✅ \n",
		"coder": "\t修复解析器 🦀\n" + strings.Repeat("Keep the tests green — Grün ✓\n", 400) + "END-CODER-🧪\n\n",
	}
	for name, task := range tasks {
		if len(task) <= 8000 {
			t.Fatalf("%s task is %d bytes, want it past the old 8000 cap", name, len(task))
		}
	}
	for _, guarded := range []bool{false, true} {
		t.Run(fmt.Sprintf("guarded=%t", guarded), func(t *testing.T) {
			rt, job, journal := newConsoleProgressPersistenceRuntime(t, []consoleProgressPersistenceLLMStep{
				{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "call_spawn", Name: "spawn", Arguments: map[string]any{"task": tasks["spawn"], "tools": []any{"work"}}}}}},
				{result: llm.Result{ToolCalls: []llm.ToolCall{{ID: "call_coder", Name: "coder", Arguments: map[string]any{"task": tasks["coder"], "coder": "codex"}}}}},
				{result: llm.Result{Text: `{"type":"final","output":"done"}`}},
			}, "work", guarded)
			var mu sync.Mutex
			got := map[string]string{}
			for name := range tasks {
				if err := job.Generation.commonDeps.Registry().Register(consoleWorkerTaskTool{name: name, mu: &mu, got: got}); err != nil {
					t.Fatal(err)
				}
			}
			frames, unsubscribe := rt.streamHub.Subscribe(job.TaskID)
			defer unsubscribe()
			rt.handleTaskJob(context.Background(), job.ConversationKey, job)

			mu.Lock()
			for name, task := range tasks {
				if got[name] != task {
					t.Fatalf("%s tool got %d bytes, want the call's own %d", name, len(got[name]), len(task))
				}
			}
			mu.Unlock()

			check := func(stage string, activity *consoleActivityProgress) {
				t.Helper()
				if activity == nil {
					t.Fatalf("%s: no activity", stage)
				}
				workers := map[string]consoleActivityWorker{}
				for _, worker := range activity.Workers {
					workers[worker.Kind] = worker
				}
				for kind, name := range map[string]string{"subagent": "spawn", "coder": "coder"} {
					worker, ok := workers[kind]
					if !ok {
						t.Fatalf("%s: no %s worker in %+v", stage, kind, activity.Workers)
					}
					if worker.Task != tasks[name] {
						t.Fatalf("%s: %s worker task = %d bytes ending %q, want %d bytes", stage, kind, len(worker.Task), lastRunes(worker.Task), len(tasks[name]))
					}
					var entry *consoleActivityEntry
					for i := range activity.History {
						if activity.History[i].ID == worker.ActivityID {
							entry = &activity.History[i]
						}
					}
					if entry == nil || entry.Args["task"] != tasks[name] {
						t.Fatalf("%s: %s call args = %+v", stage, name, entry)
					}
				}
			}

			var live *consoleActivityProgress
		drain:
			for {
				select {
				case frame := <-frames:
					if frame.Activity != nil {
						live = frame.Activity
					}
				default:
					break drain
				}
			}
			// Through the frame's JSON, as the stream sends it.
			raw, err := json.Marshal(live)
			if err != nil {
				t.Fatal(err)
			}
			var streamed consoleActivityProgress
			if err := json.Unmarshal(raw, &streamed); err != nil {
				t.Fatal(err)
			}
			check("streamed", &streamed)

			// Rebuild the task projection from the durable journal, as a fresh runtime does.
			reloaded, err := daemonruntime.NewConsoleFileStore(daemonruntime.ConsoleFileStoreOptions{
				RootDir: t.TempDir(), Persist: true, Journal: journal,
			})
			if err != nil {
				t.Fatal(err)
			}
			task, ok := reloaded.Get(job.TaskID)
			if !ok || task.Status != daemonruntime.TaskDone {
				t.Fatalf("restored task = %+v", task)
			}
			raw, err = json.Marshal(task.Result)
			if err != nil {
				t.Fatal(err)
			}
			var saved struct {
				Activity *consoleActivityProgress `json:"activity"`
			}
			if err := json.Unmarshal(raw, &saved); err != nil {
				t.Fatal(err)
			}
			check("restored", saved.Activity)
		})
	}
}
