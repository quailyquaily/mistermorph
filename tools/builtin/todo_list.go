package builtin

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

// TodoListTool lists the TODO list (the scheduled tasks in agent.db), enabled and disabled alike.
// It only reads: it never changes or runs a task.
type TodoListTool struct {
	cronPath string
}

// NewTodoListTool returns the tool for the TODO list whose cron.yaml path is cronPath, the same
// list todo_update changes.
func NewTodoListTool(cronPath string) *TodoListTool {
	return &TodoListTool{cronPath: strings.TrimSpace(cronPath)}
}

func (t *TodoListTool) Name() string { return "todo_list" }

func (t *TodoListTool) Description() string {
	return "Lists every task in the TODO list (scheduled agent tasks): one-time and recurring, enabled and disabled. " +
		"Each task has its id, title, content, schedule (at or cron, and tz) and an `enabled` boolean. " +
		"Read-only: it never changes or runs a task. Use it to find a task's id or to check which tasks are on or off."
}

func (t *TodoListTool) ParameterSchema() string {
	schema := map[string]any{
		"type":                 "object",
		"properties":           map[string]any{},
		"additionalProperties": false,
	}
	raw, _ := json.Marshal(schema)
	return string(raw)
}

// todoListTaskOutput is one task of the list. Enabled is always present. bash_env values are
// left out, since they may be secrets; only the variable names are listed.
type todoListTaskOutput struct {
	ID            string   `json:"id"`
	Title         string   `json:"title"`
	Enabled       bool     `json:"enabled"`
	At            string   `json:"at,omitempty"`
	Cron          string   `json:"cron,omitempty"`
	TZ            string   `json:"tz,omitempty"`
	Content       string   `json:"content"`
	ChatID        string   `json:"chat_id,omitempty"`
	WorkspaceDir  string   `json:"workspace_dir,omitempty"`
	BashEnvNames  []string `json:"bash_env_names,omitempty"`
	LastRunAt     string   `json:"last_run_at,omitempty"`
	LastRunStatus string   `json:"last_run_status,omitempty"`
}

type todoListOutput struct {
	Count int                  `json:"count"`
	Tasks []todoListTaskOutput `json:"tasks"`
}

func (t *TodoListTool) Execute(ctx context.Context, _ map[string]any) (string, error) {
	if t == nil || t.cronPath == "" {
		return "", fmt.Errorf("todo_list is not configured")
	}
	tasks, err := cronstore.NewStore(t.cronPath).Tasks(ctx)
	if err != nil {
		return "", fmt.Errorf("todo_list: read the TODO list: %w", err)
	}
	out := todoListOutput{Count: len(tasks), Tasks: make([]todoListTaskOutput, 0, len(tasks))}
	for _, task := range tasks {
		item := todoListTaskOutput{
			ID:            task.ID,
			Title:         task.Title,
			Enabled:       cronstore.TaskEnabled(task),
			At:            task.At,
			Cron:          task.Cron,
			TZ:            task.TZ,
			Content:       task.Content,
			ChatID:        task.ChatID,
			WorkspaceDir:  task.WorkspaceDir,
			LastRunAt:     task.LastRunAt,
			LastRunStatus: task.LastRunStatus,
		}
		for _, ref := range task.BashEnv {
			item.BashEnvNames = append(item.BashEnvNames, strings.TrimSpace(ref.Name))
		}
		out.Tasks = append(out.Tasks, item)
	}
	raw, err := json.Marshal(out)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}
