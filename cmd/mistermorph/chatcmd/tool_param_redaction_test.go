package chatcmd

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/charmbracelet/x/ansi"
	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/agentdb"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

// chatRedactionSecret stands for a credential passed in todo_update's bash_env; the chat's activity
// line and transcript may show its name but never the value.
const chatRedactionSecret = "synthetic-secret-value-0777"

type chatRedactionLLM struct {
	mu        sync.Mutex
	responses []llm.Result
}

func (c *chatRedactionLLM) Chat(context.Context, llm.Request) (llm.Result, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.responses) == 0 {
		return llm.Result{Text: `{"type":"final","reasoning":"t","output":"done"}`}, nil
	}
	next := c.responses[0]
	c.responses = c.responses[1:]
	return next, nil
}

type chatRedactionTodoLLM struct{}

func (chatRedactionTodoLLM) Chat(context.Context, llm.Request) (llm.Result, error) {
	return llm.Result{}, errors.New("todo_update must not need the model for an update")
}

type chatRedactionRun struct {
	transcript string
	activity   []string
	// hookParams are the parameters each hook call received, as JSON at the time of the call.
	hookParams []string
	events     []agent.Event
	tasks      []cronstore.Task
}

// runChatRedaction runs the real engine with the real todo_update tool and codemode, wired to the
// chat's own tool callbacks, for one model tool call.
func runChatRedaction(t *testing.T, call llm.ToolCall) chatRedactionRun {
	t.Helper()
	cronPath := filepath.Join(t.TempDir(), "cron.yaml")
	seeded := cronstore.Task{ID: "weekly-report", Title: "Weekly report", Cron: "0 10 * * 1", TZ: "UTC", ChatID: "tg:-1001",
		Content: "Write the weekly report", BashEnv: []cronstore.BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}}}
	if err := cronstore.NewStore(cronPath).Write(cronstore.File{Tasks: []cronstore.Task{seeded}}); err != nil {
		t.Fatal(err)
	}
	reg := tools.NewRegistry()
	if err := reg.Register(builtin.NewTodoUpdateToolWithLLM(true, cronPath, filepath.Join(filepath.Dir(cronPath), "contacts"), chatRedactionTodoLLM{}, "gpt-5.2")); err != nil {
		t.Fatal(err)
	}

	sess, output, messages := newPhase3CallbackSession()
	var run chatRedactionRun
	var mu sync.Mutex
	record := func(params map[string]any) {
		raw, _ := json.Marshal(params)
		mu.Lock()
		run.hookParams = append(run.hookParams, string(raw))
		mu.Unlock()
	}
	engine := agent.New(&chatRedactionLLM{responses: []llm.Result{{ToolCalls: []llm.ToolCall{call}}}}, reg,
		agent.Config{MaxSteps: 4}, agent.DefaultPromptSpec(), agent.WithCodeMode(agent.CodeModeOptions{}),
		agent.WithOnToolCallStart(func(ctx *agent.Context, call agent.ToolCall) {
			sess.onToolCallStart(ctx, call)
			record(call.Params)
		}),
		agent.WithOnToolCallDone(func(ctx *agent.Context, call agent.ToolCall, observation string, err error) {
			sess.onToolCallDone(ctx, call, observation, err)
			record(call.Params)
		}))
	ctx := agent.WithEventSinkContext(context.Background(), agent.EventSinkFunc(func(_ context.Context, event agent.Event) {
		mu.Lock()
		defer mu.Unlock()
		run.events = append(run.events, event)
	}))
	if _, _, err := engine.Run(ctx, "rotate the report token", agent.RunOptions{}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	run.transcript = ansi.Strip(output.String())
	for _, message := range *messages {
		if activity, ok := message.(thinkingMsg); ok {
			run.activity = append(run.activity, activity.message)
		}
	}
	if err := agentdb.CachedBeside(cronPath).Close(); err != nil {
		t.Fatal(err)
	}
	file, _, err := cronstore.NewStore(cronPath).Read()
	if err != nil {
		t.Fatal(err)
	}
	run.tasks = file.Tasks
	return run
}

func (r chatRedactionRun) assertHidden(t *testing.T, fragments ...string) {
	t.Helper()
	shown := r.transcript + "\n" + strings.Join(r.activity, "\n")
	for _, fragment := range fragments {
		if strings.Contains(shown, fragment) {
			t.Fatalf("the chat shows %q\ntranscript:\n%s\nactivity:\n%s", fragment, r.transcript, strings.Join(r.activity, "\n"))
		}
	}
	// The shared trace and agent inspector format tool events the same way.
	for _, event := range r.events {
		if event.Kind != agent.EventKindToolStart && event.Kind != agent.EventKindToolDone {
			continue
		}
		call := agent.ToolCall{Name: event.ToolName, Params: event.Args}
		traced := formatChatToolActivity(call) + "\n" + formatChatToolTranscript(call, 80)
		for _, fragment := range fragments {
			if strings.Contains(traced, fragment) {
				t.Fatalf("a traced tool event shows %q: %s", fragment, traced)
			}
		}
	}
}

func (r chatRedactionRun) assertUpdated(t *testing.T, content string, env []cronstore.BashEnvRef) {
	t.Helper()
	if len(r.tasks) != 1 || r.tasks[0].Content != content || !reflect.DeepEqual(r.tasks[0].BashEnv, env) {
		t.Fatalf("stored tasks = %#v", r.tasks)
	}
}

func TestChatToolDisplayHidesTodoUpdateBashEnvAndCodeModeSource(t *testing.T) {
	stored := []cronstore.BashEnvRef{{Name: "API_TOKEN", Value: chatRedactionSecret}}

	t.Run("direct todo_update", func(t *testing.T) {
		run := runChatRedaction(t, llm.ToolCall{ID: "direct", Name: "todo_update", Arguments: map[string]any{
			"action": "update", "id": "weekly-report", "content": "Rotate the token",
			"bash_env": []any{map[string]any{"name": "API_TOKEN", "value": chatRedactionSecret}},
		}})
		run.assertHidden(t, chatRedactionSecret)
		// The task got the real value, and the hooks saw the call as it ran.
		run.assertUpdated(t, "Rotate the token", stored)
		if len(run.hookParams) != 2 || !strings.Contains(run.hookParams[0], chatRedactionSecret) || !strings.Contains(run.hookParams[1], chatRedactionSecret) {
			t.Fatalf("hook params = %v", run.hookParams)
		}
		// Safe fields and the variable's name stay.
		want := "✓ todo_update · action: update · content: Rotate the token · id: weekly-report"
		if !strings.Contains(run.transcript, want) || !strings.Contains(run.transcript, "name: API_TOKEN") || !strings.Contains(run.transcript, "value: '[redacted]'") {
			t.Fatalf("transcript = %q", run.transcript)
		}
		if len(run.activity) == 0 || !strings.HasPrefix(run.activity[0], "todo_update · action: update") || !strings.Contains(run.activity[0], "API_TOKEN") {
			t.Fatalf("activity = %q", run.activity)
		}
	})

	t.Run("todo_update from codemode", func(t *testing.T) {
		// The value is built at run time, so only the nested call holds it whole.
		code := `const token = ["synthetic", "secret", "value", "0777"].join("-");
const result = JSON.parse(await tools.todo_update({action: "update", id: "weekly-report", content: "Rotate the token", bash_env: [{name: "API_TOKEN", value: token}]}));
return result.task.bash_env_names;`
		run := runChatRedaction(t, llm.ToolCall{ID: "script", Name: "codemode", Arguments: map[string]any{"code": code}})
		run.assertHidden(t, chatRedactionSecret, `"synthetic"`, "join(")
		run.assertUpdated(t, "Rotate the token", stored)
		// Hooks: codemode start, nested start, nested done, codemode done; the nested call ran with
		// the value and the codemode call with its source.
		if len(run.hookParams) != 4 || !strings.Contains(run.hookParams[1], chatRedactionSecret) || !strings.Contains(run.hookParams[3], "join(") {
			t.Fatalf("hook params = %v", run.hookParams)
		}
		if !strings.Contains(run.transcript, "    ✓ todo_update · action: update · content: Rotate the token · id: weekly-report\n") {
			t.Fatalf("nested call missing from transcript: %q", run.transcript)
		}
		wantScript := "codemode · code: [withheld] · code_chars: " + strconv.Itoa(len([]rune(code))) + " · code_lines: 3"
		if !strings.Contains(run.transcript, "✓ "+wantScript) || len(run.activity) == 0 || run.activity[0] != wantScript {
			t.Fatalf("codemode display, transcript = %q, activity = %q", run.transcript, run.activity)
		}
		// Each nested start sets the activity line; it names the variable only.
		if len(run.activity) < 2 || !strings.HasPrefix(run.activity[1], "todo_update · action: update") || !strings.Contains(run.activity[1], "API_TOKEN") {
			t.Fatalf("activity = %q", run.activity)
		}
		for _, event := range run.events {
			if event.ToolName == "codemode" && event.Kind == agent.EventKindToolDone {
				traced := formatChatToolTranscript(agent.ToolCall{Name: event.ToolName, Params: event.Args}, 80)
				if traced != wantScript {
					t.Fatalf("traced codemode event = %q, want %q", traced, wantScript)
				}
			}
		}
	})

	t.Run("codemode source with the value", func(t *testing.T) {
		code := `await tools.todo_update({action: "update", id: "weekly-report", bash_env: [{name: "API_TOKEN", value: "` + chatRedactionSecret + `"}]}); return "ok"`
		run := runChatRedaction(t, llm.ToolCall{ID: "script", Name: "codemode", Arguments: map[string]any{"code": code}})
		run.assertHidden(t, chatRedactionSecret, "await tools")
		run.assertUpdated(t, "Write the weekly report", stored)
		if !strings.Contains(run.transcript, "✓ codemode · code: [withheld]") {
			t.Fatalf("transcript = %q", run.transcript)
		}
	})

	t.Run("malformed params", func(t *testing.T) {
		cases := []llm.ToolCall{
			{ID: "env-string", Name: "todo_update", Arguments: map[string]any{"action": "update", "id": "weekly-report", "bash_env": "API_TOKEN=" + chatRedactionSecret}},
			{ID: "env-entry", Name: "todo_update", Arguments: map[string]any{"action": "update", "id": "weekly-report", "bash_env": []any{"API_TOKEN=" + chatRedactionSecret}}},
			{ID: "code-object", Name: "codemode", Arguments: map[string]any{"code": map[string]any{"source": chatRedactionSecret}}},
			{ID: "code-sizes", Name: "codemode", Arguments: map[string]any{"code": "[withheld]", "code_chars": chatRedactionSecret}},
		}
		for _, call := range cases {
			t.Run(call.ID, func(t *testing.T) {
				run := runChatRedaction(t, call)
				run.assertHidden(t, chatRedactionSecret)
				// Nothing was stored: the seeded task is unchanged.
				run.assertUpdated(t, "Write the weekly report", []cronstore.BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}})
				if !strings.Contains(run.transcript, call.Name) {
					t.Fatalf("transcript = %q", run.transcript)
				}
			})
		}
	})
}
