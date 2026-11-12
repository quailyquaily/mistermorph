package builtin

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
	"github.com/quailyquaily/mistermorph/tools"
)

// todoSyntheticSecret stands for a credential in bash_env; no tool result, error or log may show it.
const todoSyntheticSecret = "synthetic-secret-value-0002"

// todoDispatch runs todo_update the way the agent does: looked up by name in a registry, with
// arguments decoded from the model's JSON.
type todoDispatch struct {
	t        *testing.T
	tool     tools.Tool
	cronPath string
	logs     *bytes.Buffer
}

func newTodoDispatch(t *testing.T) *todoDispatch {
	t.Helper()
	root := t.TempDir()
	return newTodoDispatchAt(t, filepath.Join(root, "cron.yaml"))
}

func newTodoDispatchAt(t *testing.T, cronPath string) *todoDispatch {
	t.Helper()
	reg := tools.NewRegistry()
	contactsDir := filepath.Join(filepath.Dir(cronPath), "contacts")
	if err := reg.Register(NewTodoUpdateToolWithLLM(true, cronPath, contactsDir, &stubTodoToolLLMClient{}, "gpt-5.2")); err != nil {
		t.Fatal(err)
	}
	tool, ok := reg.Get("todo_update")
	if !ok {
		t.Fatal("todo_update not registered")
	}
	var logs bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })
	return &todoDispatch{t: t, tool: tool, cronPath: cronPath, logs: &logs}
}

func (d *todoDispatch) call(ctx context.Context, args string) (string, error) {
	d.t.Helper()
	var params map[string]any
	if err := json.Unmarshal([]byte(args), &params); err != nil {
		d.t.Fatalf("arguments %s: %v", args, err)
	}
	out, err := d.tool.Execute(ctx, params)
	if strings.Contains(out, todoSyntheticSecret) {
		d.t.Fatalf("tool result shows a bash_env value: %s", out)
	}
	if err != nil && strings.Contains(err.Error(), todoSyntheticSecret) {
		d.t.Fatalf("tool error shows a bash_env value: %v", err)
	}
	if strings.Contains(d.logs.String(), todoSyntheticSecret) {
		d.t.Fatalf("log shows a bash_env value: %s", d.logs.String())
	}
	return out, err
}

func (d *todoDispatch) mustCall(args string) map[string]any {
	d.t.Helper()
	out, err := d.call(context.Background(), args)
	if err != nil {
		d.t.Fatalf("todo_update %s: %v", args, err)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(out), &parsed); err != nil {
		d.t.Fatalf("result %s: %v", out, err)
	}
	return parsed
}

// reload reads the list from agent.db after dropping the open handle.
func (d *todoDispatch) reload() []cronstore.Task {
	d.t.Helper()
	if err := agentdb.CachedBeside(d.cronPath).Close(); err != nil {
		d.t.Fatal(err)
	}
	file, _, err := cronstore.NewStore(d.cronPath).Read()
	if err != nil {
		d.t.Fatal(err)
	}
	return file.Tasks
}

func todoTaskByID(t *testing.T, tasks []cronstore.Task, id string) cronstore.Task {
	t.Helper()
	for _, task := range tasks {
		if task.ID == id {
			return task
		}
	}
	t.Fatalf("task %s not stored: %#v", id, tasks)
	return cronstore.Task{}
}

func mustJSON(t *testing.T, v any) string {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestTodoUpdateSchemaOffersUpdateAndBashEnv(t *testing.T) {
	tool := NewTodoUpdateTool(true, "", "")
	var schema struct {
		Properties map[string]struct {
			Enum        []string `json:"enum"`
			Description string   `json:"description"`
			Items       struct {
				Type       string         `json:"type"`
				Properties map[string]any `json:"properties"`
				Required   []string       `json:"required"`
			} `json:"items"`
		} `json:"properties"`
		Required []string `json:"required"`
	}
	if err := json.Unmarshal([]byte(tool.ParameterSchema()), &schema); err != nil {
		t.Fatal(err)
	}
	if got := schema.Properties["action"].Enum; !reflect.DeepEqual(got, []string{"add_once", "add_recurring", "update", "delete"}) {
		t.Fatalf("action enum = %v", got)
	}
	env := schema.Properties["bash_env"]
	if env.Items.Type != "object" || !reflect.DeepEqual(env.Items.Required, []string{"name", "value"}) || len(env.Items.Properties) != 2 {
		t.Fatalf("bash_env schema = %+v", env)
	}
	if !strings.Contains(env.Description, "[] clears") || !strings.Contains(env.Description, "omitting bash_env keeps") {
		t.Fatalf("bash_env description = %q", env.Description)
	}
	if !strings.Contains(schema.Properties["action"].Description, "Do not delete and re-add") ||
		!strings.Contains(tool.Description(), "use update with the task id") {
		t.Fatal("tool help does not steer edits to update")
	}
}

func TestTodoUpdateAddKeepsBashEnvAndRedactsIt(t *testing.T) {
	workspaceDir := t.TempDir()
	for _, kind := range []string{"add_once", "add_recurring"} {
		t.Run(kind, func(t *testing.T) {
			d := newTodoDispatch(t)
			args := map[string]any{
				"action": kind, "id": "report", "title": "Report", "content": "Send the report", "tz": "Asia/Tokyo",
				"chat_id": "tg:-1001", "workspace_dir": workspaceDir,
				"bash_env": []map[string]string{{"name": "REPORT_MODE", "value": "weekly"}, {"name": "API_TOKEN", "value": todoSyntheticSecret}},
			}
			if kind == "add_once" {
				args["at"] = "2030-01-02 09:00"
			} else {
				args["cron"] = "0 10 * * 1"
			}
			result := d.mustCall(mustJSON(t, args))
			task := result["task"].(map[string]any)
			if _, ok := task["bash_env"]; ok {
				t.Fatalf("result shows bash_env: %v", result)
			}
			if names := task["bash_env_names"]; !reflect.DeepEqual(names, []any{"REPORT_MODE", "API_TOKEN"}) {
				t.Fatalf("bash_env_names = %v", names)
			}
			stored := todoTaskByID(t, d.reload(), "report")
			want := []cronstore.BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}, {Name: "API_TOKEN", Value: todoSyntheticSecret}}
			if !reflect.DeepEqual(stored.BashEnv, want) || stored.WorkspaceDir != workspaceDir || stored.ChatID != "tg:-1001" || stored.TZ != "Asia/Tokyo" {
				t.Fatalf("stored = %#v", stored)
			}

			// Delete's result does not show the values either.
			result = d.mustCall(`{"action":"delete","id":"report"}`)
			if names := result["deleted"].(map[string]any)["bash_env_names"]; !reflect.DeepEqual(names, []any{"REPORT_MODE", "API_TOKEN"}) {
				t.Fatalf("deleted bash_env_names = %v", names)
			}
			if tasks := d.reload(); len(tasks) != 0 {
				t.Fatalf("tasks after delete = %#v", tasks)
			}
		})
	}
}

func TestTodoUpdateRejectsMalformedBashEnvOnAdd(t *testing.T) {
	for name, env := range map[string]string{
		"not an array":   `"API_TOKEN=` + todoSyntheticSecret + `"`,
		"shorthand":      `[{"API_TOKEN":"` + todoSyntheticSecret + `"}]`,
		"number value":   `[{"name":"PORT","value":8080}]`,
		"invalid name":   `[{"name":"1BAD","value":"` + todoSyntheticSecret + `"}]`,
		"duplicate name": `[{"name":"A","value":"x"},{"name":"A","value":"` + todoSyntheticSecret + `"}]`,
	} {
		t.Run(name, func(t *testing.T) {
			d := newTodoDispatch(t)
			if _, err := d.call(context.Background(), `{"action":"add_recurring","id":"x","content":"c","cron":"0 9 * * *","bash_env":`+env+`}`); err == nil {
				t.Fatal("add accepted")
			}
			if tasks := d.reload(); len(tasks) != 0 {
				t.Fatalf("tasks = %#v", tasks)
			}
		})
	}
}

// seedTodoTask stores a task with every setting the tool does not write, and a last run, as the
// Console or cron.yaml would have left it.
func seedTodoTask(t *testing.T, cronPath string, kind string) cronstore.Task {
	t.Helper()
	off := false
	task := cronstore.Task{
		ID: "report", Title: "Report", Enabled: &off, TZ: "Asia/Tokyo", Content: "Send the [John](tg:@john) report",
		ChatID: "tg:-1001", Mention: "@john", LLMProfile: "batch", WorkspaceDir: "/srv/reports",
		BashEnv: []cronstore.BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}, {Name: "API_TOKEN", Value: todoSyntheticSecret}},
	}
	if kind == "once" {
		task.At = "2030-01-02 09:00"
	} else {
		task.Cron = "0 10 * * 1"
	}
	store := cronstore.NewStore(cronPath)
	other := cronstore.Task{ID: "other", Cron: "*/5 * * * *", Content: "Ping"}
	if err := store.Write(cronstore.File{Tasks: []cronstore.Task{task, other}}); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordRunResult(task.ID, cronstore.RunStatusDone); err != nil {
		t.Fatal(err)
	}
	stored, _, err := store.FindByID(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	return stored
}

func TestTodoUpdateContentEditKeepsBashEnvAndEverythingElse(t *testing.T) {
	for _, kind := range []string{"once", "recur"} {
		t.Run(kind, func(t *testing.T) {
			d := newTodoDispatch(t)
			before := seedTodoTask(t, d.cronPath, kind)
			result := d.mustCall(`{"action":"update","id":"report","content":"Send the revised [John](tg:@john) report"}`)
			if result["action"] != "update" || !reflect.DeepEqual(result["fields"], []any{"content"}) || result["task_count"] != float64(2) {
				t.Fatalf("result = %v", result)
			}
			task := result["task"].(map[string]any)
			if task["id"] != "report" || !reflect.DeepEqual(task["bash_env_names"], []any{"REPORT_MODE", "API_TOKEN"}) {
				t.Fatalf("result task = %v", task)
			}
			tasks := d.reload()
			if len(tasks) != 2 || tasks[0].ID != "report" {
				t.Fatalf("list = %#v", tasks)
			}
			want := before
			want.Content = "Send the revised [John](tg:@john) report"
			if !reflect.DeepEqual(tasks[0], want) {
				t.Fatalf("after = %#v\nwant %#v", tasks[0], want)
			}
		})
	}
}

func TestTodoUpdateSetsReplacesClearsAndKeepsBashEnv(t *testing.T) {
	for _, kind := range []string{"once", "recur"} {
		t.Run(kind, func(t *testing.T) {
			d := newTodoDispatch(t)
			before := seedTodoTask(t, d.cronPath, kind)
			steps := []struct {
				args string
				want []cronstore.BashEnvRef
			}{
				{`{"action":"update","id":"report","bash_env":[]}`, nil},
				{`{"action":"update","id":"report","title":"Renamed"}`, nil},
				{`{"action":"update","id":"report","bash_env":[{"name":"MODE","value":"a"}]}`, []cronstore.BashEnvRef{{Name: "MODE", Value: "a"}}},
				{`{"action":"update","id":"report","content":"Other text","people":[]}`, []cronstore.BashEnvRef{{Name: "MODE", Value: "a"}}},
				{`{"action":"update","id":"report","bash_env":[{"name":"API_TOKEN","value":"` + todoSyntheticSecret + `"},{"name":"MODE","value":"b"}]}`,
					[]cronstore.BashEnvRef{{Name: "API_TOKEN", Value: todoSyntheticSecret}, {Name: "MODE", Value: "b"}}},
				{`{"action":"update","id":"report","tz":"UTC+8"}`, []cronstore.BashEnvRef{{Name: "API_TOKEN", Value: todoSyntheticSecret}, {Name: "MODE", Value: "b"}}},
			}
			for _, step := range steps {
				d.mustCall(step.args)
				got := todoTaskByID(t, d.reload(), "report")
				if !reflect.DeepEqual(got.BashEnv, step.want) {
					t.Fatalf("%s: bash_env = %+v, want %+v", step.args, got.BashEnv, step.want)
				}
				if got.WorkspaceDir != before.WorkspaceDir || got.ChatID != before.ChatID || got.LLMProfile != before.LLMProfile ||
					cronstore.ScheduleForTask(got) != cronstore.ScheduleForTask(before) || got.LastRunStatus != before.LastRunStatus {
					t.Fatalf("%s: other fields changed: %#v", step.args, got)
				}
			}
		})
	}
}

func TestTodoUpdateClearsAndSwitchesExplicitly(t *testing.T) {
	workspaceDir := t.TempDir()
	d := newTodoDispatch(t)
	seedTodoTask(t, d.cronPath, "once")
	d.mustCall(`{"action":"update","id":"report","cron":"0 8 * * *","chat_id":"","title":""}`)
	got := todoTaskByID(t, d.reload(), "report")
	if got.At != "" || got.Cron != "0 8 * * *" || got.ChatID != "" || got.Title != cronstore.DefaultTaskTitle || len(got.BashEnv) != 2 {
		t.Fatalf("after switch = %#v", got)
	}
	d.mustCall(mustJSON(t, map[string]any{"action": "update", "id": "report", "workspace_dir": workspaceDir}))
	if got = todoTaskByID(t, d.reload(), "report"); got.WorkspaceDir != workspaceDir {
		t.Fatalf("workspace = %q", got.WorkspaceDir)
	}
	d.mustCall(`{"action":"update","id":"report","workspace_dir":"","at":"2031-01-01 08:00"}`)
	if got = todoTaskByID(t, d.reload(), "report"); got.WorkspaceDir != "" || got.At != "2031-01-01 08:00" || got.Cron != "" || len(got.BashEnv) != 2 {
		t.Fatalf("after clear = %#v", got)
	}
}

func TestTodoUpdateRejectsInvalidUpdatesWithoutChanges(t *testing.T) {
	for _, kind := range []string{"once", "recur"} {
		t.Run(kind, func(t *testing.T) {
			d := newTodoDispatch(t)
			seedTodoTask(t, d.cronPath, kind)
			before := d.reload()
			cases := map[string]string{
				"unknown id":         `{"action":"update","id":"missing","content":"x"}`,
				"no id":              `{"action":"update","content":"x"}`,
				"no fields":          `{"action":"update","id":"report"}`,
				"null bash_env":      `{"action":"update","id":"report","bash_env":null}`,
				"null title":         `{"action":"update","id":"report","title":null}`,
				"number content":     `{"action":"update","id":"report","content":7}`,
				"bash_env object":    `{"action":"update","id":"report","bash_env":{"name":"A","value":"` + todoSyntheticSecret + `"}}`,
				"bash_env value num": `{"action":"update","id":"report","bash_env":[{"name":"A","value":1}]}`,
				"invalid env name":   `{"action":"update","id":"report","content":"x","bash_env":[{"name":"BAD-NAME","value":"` + todoSyntheticSecret + `"}]}`,
				"empty env name":     `{"action":"update","id":"report","bash_env":[{"name":"","value":"` + todoSyntheticSecret + `"}]}`,
				"duplicate env name": `{"action":"update","id":"report","bash_env":[{"name":"A","value":"x"},{"name":"A","value":"` + todoSyntheticSecret + `"}]}`,
				"invalid at":         `{"action":"update","id":"report","content":"x","at":"next week"}`,
				"invalid cron":       `{"action":"update","id":"report","content":"x","cron":"daily"}`,
				"both schedules":     `{"action":"update","id":"report","at":"2030-01-02 09:00","cron":"0 9 * * *"}`,
				"no schedule":        `{"action":"update","id":"report","at":"","cron":""}`,
				"invalid tz":         `{"action":"update","id":"report","tz":"Mars/Base"}`,
				"empty content":      `{"action":"update","id":"report","content":""}`,
				"missing workspace":  `{"action":"update","id":"report","workspace_dir":"/definitely/not/here/ft97"}`,
				"people":             `{"action":"update","id":"report","content":"Remind John","people":["John"]}`,
			}
			for name, args := range cases {
				if _, err := d.call(context.Background(), args); err == nil {
					t.Fatalf("%s: update accepted", name)
				}
				if after := d.reload(); !reflect.DeepEqual(after, before) {
					t.Fatalf("%s: list changed:\n%#v\nwas %#v", name, after, before)
				}
			}
		})
	}
}

// A cron.yaml from before agent.db, with bash_env in its shorthand form, is imported when the
// tool first opens the list; editing a task's content then keeps its settings.
func TestTodoUpdateEditsATaskImportedFromCronYAML(t *testing.T) {
	dir := t.TempDir()
	raw := `version: 1
tasks:
  - id: weekly-report
    title: Weekly report
    cron: "0 10 * * 1"
    tz: UTC+8
    chat_id: "tg:-1001"
    workspace_dir: /srv/reports
    content: "Weekly report"
    bash_env:
      - REPORT_MODE: weekly
      - name: API_TOKEN
        value: "` + todoSyntheticSecret + `"
`
	if err := os.WriteFile(filepath.Join(dir, "cron.yaml"), []byte(raw), 0o600); err != nil {
		t.Fatal(err)
	}
	d := newTodoDispatchAt(t, filepath.Join(dir, "cron.yaml"))
	d.mustCall(`{"action":"update","id":"weekly-report","content":"Weekly report, with charts"}`)
	got := todoTaskByID(t, d.reload(), "weekly-report")
	want := cronstore.Task{ID: "weekly-report", Title: "Weekly report", Cron: "0 10 * * 1", TZ: "UTC+8", ChatID: "tg:-1001",
		WorkspaceDir: "/srv/reports", Content: "Weekly report, with charts",
		BashEnv: []cronstore.BashEnvRef{{Name: "REPORT_MODE", Value: "weekly"}, {Name: "API_TOKEN", Value: todoSyntheticSecret}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("task = %#v\nwant %#v", got, want)
	}
	if _, err := os.Stat(filepath.Join(dir, "cron.yaml.imported")); err != nil {
		t.Fatalf("cron.yaml not imported: %v", err)
	}
}
