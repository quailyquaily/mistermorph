package builtin

import (
	"context"
	"fmt"
	"sort"
	"strings"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

// todoUpdateOutput is the tool's result for every action. Tasks in it never carry bash_env
// values, only their names.
type todoUpdateOutput struct {
	OK        bool                  `json:"ok"`
	Action    string                `json:"action"`
	TaskCount int                   `json:"task_count"`
	Task      *todoUpdateTaskOutput `json:"task,omitempty"`
	Deleted   *todoUpdateTaskOutput `json:"deleted,omitempty"`
	Fields    []string              `json:"fields,omitempty"`
	Warnings  []string              `json:"warnings,omitempty"`
}

// todoUpdateTaskOutput is a task with its bash_env reduced to the variable names: the values
// may be secrets.
type todoUpdateTaskOutput struct {
	cronstore.Task
	BashEnvNames []string `json:"bash_env_names,omitempty"`
}

func redactTodoUpdateTask(task *cronstore.Task) *todoUpdateTaskOutput {
	if task == nil {
		return nil
	}
	out := &todoUpdateTaskOutput{Task: *task}
	for _, ref := range task.BashEnv {
		out.BashEnvNames = append(out.BashEnvNames, strings.TrimSpace(ref.Name))
	}
	out.Task.BashEnv = nil
	return out
}

func todoUpdateAddOutput(result cronstore.AddResult) todoUpdateOutput {
	return todoUpdateOutput{
		OK:        result.OK,
		Action:    result.Action,
		TaskCount: result.TaskCount,
		Task:      redactTodoUpdateTask(result.Task),
		Warnings:  result.Warnings,
	}
}

// todoUpdatePatchFields are the parameters update accepts besides action and id.
var todoUpdatePatchFields = map[string]bool{
	"title": true, "content": true, "at": true, "cron": true, "tz": true,
	"chat_id": true, "workspace_dir": true, "bash_env": true,
}

// parseTodoUpdatePatch reads the fields an update sets. A parameter that is absent is left as
// it is; a present one is written, "" (or [] for bash_env) clearing it. null is refused rather
// than read as either.
func parseTodoUpdatePatch(ctx context.Context, params map[string]any) (cronstore.TaskPatch, error) {
	var patch cronstore.TaskPatch
	for _, name := range sortedTodoUpdateParamNames(params) {
		if name == "action" || name == "id" {
			continue
		}
		raw := params[name]
		if name == "people" {
			if people, err := parseTodoUpdatePeopleValue(raw); err != nil || len(people) > 0 {
				return cronstore.TaskPatch{}, fmt.Errorf("people is not used by update: content is stored exactly as given, so write people references such as [John](tg:@john) in content")
			}
			continue
		}
		if !todoUpdatePatchFields[name] {
			continue
		}
		if raw == nil {
			if name == "bash_env" {
				return cronstore.TaskPatch{}, fmt.Errorf("bash_env must be an array; omit it to keep the current value, or pass [] to clear it")
			}
			return cronstore.TaskPatch{}, fmt.Errorf("%s must be a string; omit it to keep the current value, or pass \"\" to clear it", name)
		}
		if name == "bash_env" {
			refs, err := parseTodoUpdateBashEnvValue(raw)
			if err != nil {
				return cronstore.TaskPatch{}, err
			}
			patch.BashEnv = &refs
			continue
		}
		value, ok := raw.(string)
		if !ok {
			return cronstore.TaskPatch{}, fmt.Errorf("%s must be a string", name)
		}
		value = strings.TrimSpace(value)
		switch name {
		case "title":
			patch.Title = &value
		case "content":
			patch.Content = &value
		case "at":
			patch.At = &value
		case "cron":
			patch.Cron = &value
		case "tz":
			patch.TZ = &value
		case "chat_id":
			patch.ChatID = &value
		case "workspace_dir":
			if value != "" {
				resolved, err := resolveTodoUpdateWorkspaceDir(ctx, value)
				if err != nil {
					return cronstore.TaskPatch{}, err
				}
				value = resolved
			}
			patch.WorkspaceDir = &value
		}
	}
	if patch.IsEmpty() {
		return cronstore.TaskPatch{}, fmt.Errorf("update needs at least one field to change: title, content, at, cron, tz, chat_id, workspace_dir or bash_env")
	}
	return patch, nil
}

func sortedTodoUpdateParamNames(params map[string]any) []string {
	names := make([]string, 0, len(params))
	for name := range params {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// parseTodoUpdateBashEnvOptional reads bash_env for an add: absent or null is none.
func parseTodoUpdateBashEnvOptional(params map[string]any) ([]cronstore.BashEnvRef, error) {
	raw, exists := params["bash_env"]
	if !exists || raw == nil {
		return nil, nil
	}
	return parseTodoUpdateBashEnvValue(raw)
}

// parseTodoUpdateBashEnvValue reads bash_env as the task stores it, a list of {name, value}
// objects. Errors name the entry, never its value.
func parseTodoUpdateBashEnvValue(raw any) ([]cronstore.BashEnvRef, error) {
	const shape = "bash_env must be an array of {\"name\": ..., \"value\": ...} objects"
	switch v := raw.(type) {
	case []cronstore.BashEnvRef:
		return append([]cronstore.BashEnvRef{}, v...), nil
	case []map[string]any:
		items := make([]any, len(v))
		for i := range v {
			items[i] = v[i]
		}
		raw = items
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("%s", shape)
	}
	refs := make([]cronstore.BashEnvRef, 0, len(items))
	for i, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s; bash_env[%d] is not an object", shape, i)
		}
		for key := range entry {
			if key != "name" && key != "value" {
				return nil, fmt.Errorf("%s; bash_env[%d] has an unknown field", shape, i)
			}
		}
		name, ok := entry["name"].(string)
		if !ok {
			return nil, fmt.Errorf("bash_env[%d].name must be a string", i)
		}
		value, ok := entry["value"].(string)
		if !ok {
			return nil, fmt.Errorf("bash_env[%d].value must be a string", i)
		}
		refs = append(refs, cronstore.BashEnvRef{Name: name, Value: value})
	}
	return refs, nil
}
