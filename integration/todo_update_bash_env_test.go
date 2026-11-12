package integration

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/llm"
)

// A run whose model edits a scheduled task through todo_update keeps the task's bash_env and
// other settings, and the bash_env values appear in no tool result, tool event or log line.
func TestRunTaskTodoUpdateKeepsBashEnvAndKeepsValuesOutOfOutput(t *testing.T) {
	const secret = "synthetic-secret-value-0004"
	stateDir := t.TempDir()
	logDir := t.TempDir()
	cronPath := filepath.Join(stateDir, "cron.yaml")
	seeded := cronstore.Task{ID: "weekly-report", Title: "Weekly report", Cron: "0 10 * * 1", TZ: "UTC+8", ChatID: "tg:-1001",
		WorkspaceDir: "/srv/reports", LLMProfile: "batch", Content: "Write the weekly report",
		BashEnv: []cronstore.BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}, {Name: "API_TOKEN", Value: secret}}}
	if err := cronstore.NewStore(cronPath).Write(cronstore.File{Tasks: []cronstore.Task{seeded}}); err != nil {
		t.Fatal(err)
	}

	cfg := DefaultConfig()
	cfg.Features.Skills = false
	cfg.Set("file_state_dir", stateDir)
	cfg.Set("llm.model", "gpt-5.2")
	cfg.Set("logging.level", "debug")
	cfg.Set("logging.include_tool_params", true)
	cfg.Set("logging.file.dir", logDir)

	calls := []llm.ToolCall{
		{ID: "edit", Name: "todo_update", Arguments: map[string]any{
			"action": "update", "id": "weekly-report", "content": "Write the weekly report with charts",
		}},
		{ID: "add", Name: "todo_update", Arguments: map[string]any{
			"action": "add_once", "id": "standup", "content": "Prepare the standup notes", "at": "2030-01-02 09:00",
			"bash_env": []any{map[string]any{"name": "API_TOKEN", "value": secret}},
		}},
		{ID: "rotate", Name: "todo_update", Arguments: map[string]any{
			"action": "update", "id": "weekly-report", "bash_env": []any{map[string]any{"name": "API_TOKEN", "value": secret + "-rotated"}},
		}},
	}
	var toolResults []string
	request := 0
	rt := newRuntimeWithStubIntegrationClient(cfg, func(_ context.Context, req llm.Request) (llm.Result, error) {
		for _, msg := range req.Messages {
			if msg.Role == "tool" {
				toolResults = append(toolResults, msg.Content)
			}
		}
		request++
		if request <= len(calls) {
			return llm.Result{ToolCalls: []llm.ToolCall{calls[request-1]}}, nil
		}
		return llm.Result{Text: `{"type":"final","output":"done"}`}, nil
	})
	var mu sync.Mutex
	var events []agent.Event
	ctx := agent.WithEventSinkContext(context.Background(), agent.EventSinkFunc(func(_ context.Context, event agent.Event) {
		mu.Lock()
		defer mu.Unlock()
		events = append(events, event)
	}))
	if _, _, err := rt.RunTask(ctx, "edit my scheduled report", agent.RunOptions{}); err != nil {
		t.Fatalf("RunTask() error = %v", err)
	}

	if err := agentdb.CachedBeside(cronPath).Close(); err != nil {
		t.Fatal(err)
	}
	file, _, err := cronstore.NewStore(cronPath).Read()
	if err != nil {
		t.Fatal(err)
	}
	if len(file.Tasks) != 2 {
		t.Fatalf("tasks = %#v", file.Tasks)
	}
	want := seeded
	want.Content = "Write the weekly report with charts"
	want.BashEnv = []cronstore.BashEnvRef{{Name: "API_TOKEN", Value: secret + "-rotated"}}
	if !reflect.DeepEqual(file.Tasks[0], want) {
		t.Fatalf("edited task = %#v\nwant %#v", file.Tasks[0], want)
	}
	if got := file.Tasks[1]; got.ID != "standup" || !reflect.DeepEqual(got.BashEnv, []cronstore.BashEnvRef{{Name: "API_TOKEN", Value: secret}}) {
		t.Fatalf("added task = %#v", got)
	}

	sawResult := false
	for _, result := range toolResults {
		if strings.Contains(result, secret) {
			t.Fatalf("a tool result shows a bash_env value: %s", result)
		}
		if strings.Contains(result, "bash_env_names") {
			sawResult = true
		}
	}
	if !sawResult {
		t.Fatalf("no todo_update result reached the model: %v", toolResults)
	}
	sawArgs := false
	for _, event := range events {
		raw, _ := json.Marshal(event)
		if strings.Contains(string(raw), secret) {
			t.Fatalf("a tool event shows a bash_env value: %s", raw)
		}
		if event.ToolName == "todo_update" && event.Args != nil {
			sawArgs = true
		}
	}
	if !sawArgs {
		t.Fatal("no todo_update tool event carried its arguments")
	}
	logged := ""
	_ = filepath.WalkDir(logDir, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			data, _ := os.ReadFile(path)
			logged += string(data)
		}
		return nil
	})
	if !strings.Contains(logged, "todo_update") {
		t.Fatalf("the log has no todo_update call to check: %q", logged)
	}
	if strings.Contains(logged, secret) {
		t.Fatal("the log shows a bash_env value")
	}
}
