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

// A codemode script that edits a scheduled task through todo_update, with bash_env values written
// as literals or built at run time, updates the task, while neither the values nor any part of the
// script's source appear in tool events or logs: the codemode call shows only the script's size, and
// the nested todo_update calls show the variable names with the values redacted.
func TestRunTaskTodoUpdateFromCodeModeKeepsValuesOutOfOutput(t *testing.T) {
	const (
		literal = "synthetic-secret-value-0099"
		dynamic = "synthetic-dynamic-value-0098"
		broken  = "synthetic-broken-value-0097"
	)
	// Fragments of every value; none may show anywhere.
	secrets := []string{literal, dynamic, broken, "synthetic-", "value-009"}

	stateDir := t.TempDir()
	logDir := t.TempDir()
	cronPath := filepath.Join(stateDir, "cron.yaml")
	seeded := cronstore.Task{ID: "weekly-report", Title: "Weekly report", Cron: "0 10 * * 1", TZ: "UTC+8", ChatID: "tg:-1001",
		WorkspaceDir: "/srv/reports", LLMProfile: "batch", Content: "Write the weekly report",
		BashEnv: []cronstore.BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}}}
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

	edit := `const token = ["synthetic", "dynamic", "value", "0098"].join("-");
let unknown = "";
try {
  await tools.todo_update({action: "update", id: "no-such-task", bash_env: [{name: "API_TOKEN", value: "synthetic-secret-value-0099"}]});
} catch (e) {
  unknown = e.message;
}
let invalid = "";
try {
  await tools.todo_update({action: "update", id: "weekly-report", content: "Not applied", bash_env: [{name: "9BAD", value: token}]});
} catch (e) {
  invalid = e.message;
}
const result = JSON.parse(await tools.todo_update({
  action: "update", id: "weekly-report", content: "Write the weekly report with charts",
  bash_env: [{name: "API_TOKEN", value: "synthetic-secret-value-0099"}, {name: "SESSION", value: token}],
}));
return {ok: result.ok, names: result.task.bash_env_names, unknown, invalid};`
	// A script that does not parse never runs; its source is withheld all the same.
	malformed := `await tools.todo_update({action: "update", id: "weekly-report", bash_env: [{name: "API_TOKEN", value: "synthetic-broken-value-0097"}]`
	calls := []llm.ToolCall{
		{ID: "edit", Name: "codemode", Arguments: map[string]any{"code": edit}},
		{ID: "malformed", Name: "codemode", Arguments: map[string]any{"code": malformed}},
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
	if _, _, err := rt.RunTask(ctx, "rotate the report token", agent.RunOptions{}); err != nil {
		t.Fatalf("RunTask() error = %v", err)
	}

	// The script's last call updated the task in place; the failed calls changed nothing.
	if err := agentdb.CachedBeside(cronPath).Close(); err != nil {
		t.Fatal(err)
	}
	file, _, err := cronstore.NewStore(cronPath).Read()
	if err != nil {
		t.Fatal(err)
	}
	want := seeded
	want.Content = "Write the weekly report with charts"
	want.BashEnv = []cronstore.BashEnvRef{{Name: "API_TOKEN", Value: literal}, {Name: "SESSION", Value: dynamic}}
	if len(file.Tasks) != 1 || !reflect.DeepEqual(file.Tasks[0], want) {
		t.Fatalf("tasks = %#v\nwant %#v", file.Tasks, want)
	}

	// The model gets the script's output, which names the variables only.
	if len(toolResults) < 2 {
		t.Fatalf("tool results = %v", toolResults)
	}
	var observation struct {
		Status string   `json:"status"`
		Output []string `json:"output"`
	}
	if err := json.Unmarshal([]byte(toolResults[0]), &observation); err != nil || observation.Status != "completed" || len(observation.Output) != 1 {
		t.Fatalf("edit script result = %s (%v)", toolResults[0], err)
	}
	var output struct {
		OK      bool     `json:"ok"`
		Names   []string `json:"names"`
		Unknown string   `json:"unknown"`
		Invalid string   `json:"invalid"`
	}
	if err := json.Unmarshal([]byte(observation.Output[0]), &output); err != nil {
		t.Fatalf("script output = %q: %v", observation.Output[0], err)
	}
	if !output.OK || !reflect.DeepEqual(output.Names, []string{"API_TOKEN", "SESSION"}) || output.Unknown == "" || output.Invalid == "" {
		t.Fatalf("script output = %+v", output)
	}
	if !strings.Contains(toolResults[len(toolResults)-1], `"status":"failed"`) {
		t.Fatalf("malformed script result = %s", toolResults[len(toolResults)-1])
	}
	for _, result := range toolResults {
		for _, secret := range secrets {
			if strings.Contains(result, secret) {
				t.Fatalf("a tool result shows %q: %s", secret, result)
			}
		}
	}

	// Events: both scripts show their size only; every nested call shows names, not values.
	scripts, nested := 0, 0
	for _, event := range events {
		raw, _ := json.Marshal(event)
		for _, secret := range secrets {
			if strings.Contains(string(raw), secret) {
				t.Fatalf("an event shows %q: %s", secret, raw)
			}
		}
		if event.Kind != agent.EventKindToolStart && event.Kind != agent.EventKindToolDone {
			continue
		}
		switch event.ToolName {
		case "codemode":
			if event.Args["code"] != "[withheld]" || event.Args["code_chars"] == nil {
				t.Fatalf("codemode event args = %#v", event.Args)
			}
			scripts++
		case "todo_update":
			if event.ParentActivityID != "edit" || event.Args["id"] == nil || event.Args["bash_env"] == nil ||
				!strings.Contains(string(raw), `"value":"[redacted]"`) {
				t.Fatalf("nested todo_update event = %s", raw)
			}
			nested++
		}
	}
	// A start and a done event for each script, and for each of the three nested calls.
	if scripts != 4 || nested != 6 {
		t.Fatalf("codemode events = %d, nested todo_update events = %d", scripts, nested)
	}

	logged := ""
	_ = filepath.WalkDir(logDir, func(path string, entry os.DirEntry, err error) error {
		if err == nil && !entry.IsDir() {
			data, _ := os.ReadFile(path)
			logged += string(data)
		}
		return nil
	})
	if !strings.Contains(logged, "tool_call_params") || !strings.Contains(logged, "code_chars") {
		t.Fatalf("the log has no codemode params to check: %q", logged)
	}
	for _, secret := range secrets {
		if strings.Contains(logged, secret) {
			t.Fatalf("the log shows %q", secret)
		}
	}
}
