package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/agentdb"
	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

type todoListTestTask struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Enabled       *bool    `json:"enabled"`
	At            string   `json:"at"`
	Cron          string   `json:"cron"`
	TZ            string   `json:"tz"`
	Content       string   `json:"content"`
	ChatID        string   `json:"chat_id"`
	BashEnvNames  []string `json:"bash_env_names"`
	LastRunStatus string   `json:"last_run_status"`
}

type todoListTestOutput struct {
	Count *int               `json:"count"`
	Tasks []todoListTestTask `json:"tasks"`
}

func todoListBool(v bool) *bool { return &v }

// todoListRows is every stored column of the TODO list, to compare the list before and after a
// query.
func todoListRows(t *testing.T, cronPath string) []string {
	t.Helper()
	db, err := agentdb.CachedBeside(cronPath).Get(context.Background())
	if err != nil {
		t.Fatalf("open agent.db: %v", err)
	}
	rows, err := db.QueryContext(context.Background(), `SELECT * FROM cron_tasks ORDER BY position, id`)
	if err != nil {
		t.Fatalf("query cron_tasks: %v", err)
	}
	defer func() { _ = rows.Close() }()
	cols, err := rows.Columns()
	if err != nil {
		t.Fatalf("columns: %v", err)
	}
	var out []string
	for rows.Next() {
		values := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			t.Fatalf("scan: %v", err)
		}
		parts := make([]string, len(cols))
		for i, col := range cols {
			if raw, ok := values[i].([]byte); ok {
				values[i] = string(raw)
			}
			parts[i] = fmt.Sprintf("%s=%v", col, values[i])
		}
		out = append(out, strings.Join(parts, "|"))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return out
}

func TestTodoListListsEveryTaskWithItsEnabledState(t *testing.T) {
	cases := []struct {
		name  string
		tasks []cronstore.Task
		want  []todoListTestTask
	}{
		{
			name: "mixed, an unset enabled is on",
			tasks: []cronstore.Task{
				{ID: "daily-report", Title: "Daily report", Cron: "0 9 * * *", TZ: "Asia/Tokyo", Content: "Write the daily report", ChatID: "tg:-1001"},
				{ID: "paused-sync", Title: "Paused sync", Enabled: todoListBool(false), Cron: "*/5 * * * *", Content: "Sync the mirror"},
				{ID: "explicit-on", Enabled: todoListBool(true), At: "2030-01-02 10:00", Content: "Call the bank"},
				{ID: "one-off-off", Enabled: todoListBool(false), At: "2030-03-04 08:30", TZ: "UTC+8", Content: "Renew the domain"},
			},
			want: []todoListTestTask{
				{ID: "daily-report", Title: "Daily report", Enabled: todoListBool(true), Cron: "0 9 * * *", TZ: "Asia/Tokyo", Content: "Write the daily report", ChatID: "tg:-1001"},
				{ID: "paused-sync", Title: "Paused sync", Enabled: todoListBool(false), Cron: "*/5 * * * *", Content: "Sync the mirror"},
				{ID: "explicit-on", Title: cronstore.DefaultTaskTitle, Enabled: todoListBool(true), At: "2030-01-02 10:00", Content: "Call the bank"},
				{ID: "one-off-off", Title: cronstore.DefaultTaskTitle, Enabled: todoListBool(false), At: "2030-03-04 08:30", TZ: "UTC+8", Content: "Renew the domain"},
			},
		},
		{
			name: "all disabled",
			tasks: []cronstore.Task{
				{ID: "a", Title: "A", Enabled: todoListBool(false), Cron: "0 1 * * *", Content: "First"},
				{ID: "b", Title: "B", Enabled: todoListBool(false), At: "2031-05-06 07:00", Content: "Second"},
			},
			want: []todoListTestTask{
				{ID: "a", Title: "A", Enabled: todoListBool(false), Cron: "0 1 * * *", Content: "First"},
				{ID: "b", Title: "B", Enabled: todoListBool(false), At: "2031-05-06 07:00", Content: "Second"},
			},
		},
		{
			name:  "empty",
			tasks: nil,
			want:  []todoListTestTask{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cronPath := filepath.Join(t.TempDir(), "cron.yaml")
			store := cronstore.NewStore(cronPath)
			if err := store.Write(cronstore.File{Tasks: tc.tasks}); err != nil {
				t.Fatalf("seed: %v", err)
			}
			before := todoListRows(t, cronPath)

			raw, err := NewTodoListTool(cronPath).Execute(context.Background(), map[string]any{})
			if err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			var out todoListTestOutput
			if err := json.Unmarshal([]byte(raw), &out); err != nil {
				t.Fatalf("output %q: %v", raw, err)
			}
			if out.Count == nil || *out.Count != len(tc.want) {
				t.Fatalf("count = %v, want %d: %s", out.Count, len(tc.want), raw)
			}
			if out.Tasks == nil {
				t.Fatalf("tasks is null, want an array: %s", raw)
			}
			for i, task := range out.Tasks {
				if task.Enabled == nil {
					t.Fatalf("task %d has no enabled field: %s", i, raw)
				}
			}
			if !reflect.DeepEqual(out.Tasks, tc.want) {
				t.Fatalf("tasks = %s, want %+v", raw, tc.want)
			}
			if after := todoListRows(t, cronPath); !reflect.DeepEqual(after, before) {
				t.Fatalf("stored tasks changed:\nbefore %v\nafter  %v", before, after)
			}
		})
	}
}

func TestTodoListEmptyResultIsAnEmptyArray(t *testing.T) {
	// A state folder that has never been used: no agent.db, no cron.yaml.
	cronPath := filepath.Join(t.TempDir(), "state", "cron.yaml")
	raw, err := NewTodoListTool(cronPath).Execute(context.Background(), nil)
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if raw != `{"count":0,"tasks":[]}` {
		t.Fatalf("output = %s", raw)
	}
	if rows := todoListRows(t, cronPath); len(rows) != 0 {
		t.Fatalf("query stored tasks: %v", rows)
	}
}

func TestTodoListHidesBashEnvValuesAndShowsLastRun(t *testing.T) {
	cronPath := filepath.Join(t.TempDir(), "cron.yaml")
	store := cronstore.NewStore(cronPath)
	if err := store.Write(cronstore.File{Tasks: []cronstore.Task{{
		ID: "with-env", Title: "With env", Enabled: todoListBool(false), Cron: "0 9 * * 1", Content: "Post the report",
		BashEnv: []cronstore.BashEnvRef{{Name: "API_TOKEN", Value: "s3cr3t-value"}, {Name: "MODE", Value: "weekly"}},
	}}}); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := store.RecordRunResult("with-env", "done"); err != nil {
		t.Fatalf("RecordRunResult: %v", err)
	}
	before := todoListRows(t, cronPath)

	raw, err := NewTodoListTool(cronPath).Execute(context.Background(), map[string]any{"path": "/elsewhere/cron.yaml", "enabled": true})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if strings.Contains(raw, "s3cr3t-value") || strings.Contains(raw, "weekly") || strings.Contains(raw, `"bash_env"`) {
		t.Fatalf("output carries bash_env values: %s", raw)
	}
	var out todoListTestOutput
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("output %q: %v", raw, err)
	}
	if len(out.Tasks) != 1 {
		t.Fatalf("tasks = %s", raw)
	}
	task := out.Tasks[0]
	if !reflect.DeepEqual(task.BashEnvNames, []string{"API_TOKEN", "MODE"}) || task.LastRunStatus != "done" {
		t.Fatalf("task = %+v", task)
	}
	if task.Enabled == nil || *task.Enabled {
		t.Fatalf("enabled = %v, want false: a query must not turn the task on", task.Enabled)
	}
	if after := todoListRows(t, cronPath); !reflect.DeepEqual(after, before) {
		t.Fatalf("stored tasks changed:\nbefore %v\nafter  %v", before, after)
	}
}

func TestTodoListReadFailuresAreErrors(t *testing.T) {
	t.Run("not configured", func(t *testing.T) {
		for _, tool := range []*TodoListTool{nil, NewTodoListTool(""), NewTodoListTool("   ")} {
			out, err := tool.Execute(context.Background(), nil)
			if err == nil || out != "" {
				t.Fatalf("Execute() = %q, %v; want an error", out, err)
			}
		}
	})
	t.Run("corrupt database", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "agent.db"), []byte(strings.Repeat("not a database ", 400)), 0o600); err != nil {
			t.Fatal(err)
		}
		out, err := NewTodoListTool(filepath.Join(dir, "cron.yaml")).Execute(context.Background(), nil)
		if err == nil || out != "" {
			t.Fatalf("Execute() = %q, %v; want an error", out, err)
		}
		if !strings.Contains(err.Error(), "todo_list") {
			t.Fatalf("error = %v, want it to name todo_list", err)
		}
	})
	t.Run("state folder is a file", func(t *testing.T) {
		dir := t.TempDir()
		blocked := filepath.Join(dir, "state")
		if err := os.WriteFile(blocked, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
		out, err := NewTodoListTool(filepath.Join(blocked, "cron.yaml")).Execute(context.Background(), nil)
		if err == nil || out != "" {
			t.Fatalf("Execute() = %q, %v; want an error", out, err)
		}
	})
	t.Run("cancelled", func(t *testing.T) {
		cronPath := filepath.Join(t.TempDir(), "cron.yaml")
		if err := cronstore.NewStore(cronPath).Write(cronstore.File{Tasks: []cronstore.Task{
			{ID: "a", Cron: "0 1 * * *", Content: "First"},
		}}); err != nil {
			t.Fatalf("seed: %v", err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		out, err := NewTodoListTool(cronPath).Execute(ctx, nil)
		if err == nil || out != "" {
			t.Fatalf("Execute() = %q, %v; want an error", out, err)
		}
	})
}

func TestTodoListSchemaTakesNoParameters(t *testing.T) {
	tool := NewTodoListTool("")
	if tool.Name() != "todo_list" {
		t.Fatalf("name = %q", tool.Name())
	}
	var schema struct {
		Type       string         `json:"type"`
		Properties map[string]any `json:"properties"`
		Required   []string       `json:"required"`
	}
	if err := json.Unmarshal([]byte(tool.ParameterSchema()), &schema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	if schema.Type != "object" || schema.Properties == nil || len(schema.Properties) != 0 || len(schema.Required) != 0 {
		t.Fatalf("schema = %s", tool.ParameterSchema())
	}
	if !strings.Contains(tool.Description(), "enabled") {
		t.Fatalf("description = %q", tool.Description())
	}
}
