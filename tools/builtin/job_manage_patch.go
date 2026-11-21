package builtin

import (
	"context"
	"fmt"
	"sort"
	"strings"

	cronstore "github.com/quailyquaily/mistermorph/internal/cron"
)

// jobManageOutput is the tool's result for every action. Tasks in it never carry bash_env
// values, only their names.
type jobManageOutput struct {
	OK        bool                 `json:"ok"`
	Action    string               `json:"action"`
	TaskCount int                  `json:"task_count"`
	Task      *jobManageTaskOutput `json:"task,omitempty"`
	Deleted   *jobManageTaskOutput `json:"deleted,omitempty"`
	Fields    []string             `json:"fields,omitempty"`
	// Enabled is the job's state, for get: a job that is off does not run on its schedule.
	Enabled  *bool    `json:"enabled,omitempty"`
	Warnings []string `json:"warnings,omitempty"`
}

// jobManageTaskOutput is a task with its bash_env reduced to the variable names: the values
// may be secrets.
type jobManageTaskOutput struct {
	cronstore.Task
	// Enabled is always shown: a job that is off does not run on its schedule.
	Enabled      bool     `json:"enabled"`
	BashEnvNames []string `json:"bash_env_names,omitempty"`
}

func redactJobManageTask(task *cronstore.Task) *jobManageTaskOutput {
	if task == nil {
		return nil
	}
	out := &jobManageTaskOutput{Task: *task, Enabled: cronstore.TaskEnabled(*task)}
	for _, ref := range task.BashEnv {
		out.BashEnvNames = append(out.BashEnvNames, strings.TrimSpace(ref.Name))
	}
	out.Task.BashEnv = nil
	return out
}

func jobManageAddOutput(result cronstore.AddResult) jobManageOutput {
	return jobManageOutput{
		OK:        result.OK,
		Action:    result.Action,
		TaskCount: result.TaskCount,
		Task:      redactJobManageTask(result.Task),
		Warnings:  result.Warnings,
	}
}

// jobManagePatchFields are the parameters update accepts besides action and id.
var jobManagePatchFields = map[string]bool{
	"title": true, "content": true, "at": true, "cron": true, "tz": true,
	"chat_id": true, "workspace_dir": true, "bash_env": true,
	"add_triggers": true, "remove_triggers": true, "uses": true, "join": true,
}

// parseJobManagePatch reads the fields an update sets. A parameter that is absent is left as
// it is; a present one is written, "" (or [] for bash_env) clearing it. null is refused rather
// than read as either.
func parseJobManagePatch(ctx context.Context, params map[string]any) (cronstore.TaskPatch, error) {
	var patch cronstore.TaskPatch
	for _, name := range sortedJobManageParamNames(params) {
		if name == "action" || name == "id" {
			continue
		}
		raw := params[name]
		if name == "people" {
			if people, err := parseJobManagePeopleValue(raw); err != nil || len(people) > 0 {
				return cronstore.TaskPatch{}, fmt.Errorf("people is not used by update: content is stored exactly as given, so write people references such as [John](tg:@john) in content")
			}
			continue
		}
		if !jobManagePatchFields[name] {
			continue
		}
		if raw == nil {
			switch name {
			case "bash_env", "uses":
				return cronstore.TaskPatch{}, fmt.Errorf("%s must be an array; omit it to keep the current value, or pass [] to clear it", name)
			case "add_triggers", "remove_triggers":
				return cronstore.TaskPatch{}, fmt.Errorf("%s must be an array; omit it to change no trigger", name)
			}
			return cronstore.TaskPatch{}, fmt.Errorf("%s must be a string; omit it to keep the current value, or pass \"\" to clear it", name)
		}
		if name == "bash_env" {
			refs, err := parseJobManageBashEnvValue(raw)
			if err != nil {
				return cronstore.TaskPatch{}, err
			}
			patch.BashEnv = &refs
			continue
		}
		switch name {
		case "add_triggers":
			triggers, err := parseJobManageTriggers(raw)
			if err != nil {
				return cronstore.TaskPatch{}, err
			}
			patch.AddTriggers = triggers
			continue
		case "remove_triggers":
			ids, err := parseJobManageTriggerIDs(raw)
			if err != nil {
				return cronstore.TaskPatch{}, err
			}
			patch.RemoveTriggers = ids
			continue
		case "uses":
			uses, err := parseJobManageUses(raw)
			if err != nil {
				return cronstore.TaskPatch{}, err
			}
			patch.Uses = &uses
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
		case "join":
			patch.Join = &value
		case "chat_id":
			patch.ChatID = &value
		case "workspace_dir":
			if value != "" {
				resolved, err := resolveJobManageWorkspaceDir(ctx, value)
				if err != nil {
					return cronstore.TaskPatch{}, err
				}
				value = resolved
			}
			patch.WorkspaceDir = &value
		}
	}
	if patch.IsEmpty() {
		return cronstore.TaskPatch{}, fmt.Errorf("update needs at least one field to change: title, content, at, cron, tz, chat_id, workspace_dir, bash_env, add_triggers, remove_triggers, uses or join")
	}
	return patch, nil
}

func sortedJobManageParamNames(params map[string]any) []string {
	names := make([]string, 0, len(params))
	for name := range params {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// parseJobManageBashEnvOptional reads bash_env for an add: absent or null is none.
func parseJobManageBashEnvOptional(params map[string]any) ([]cronstore.BashEnvRef, error) {
	raw, exists := params["bash_env"]
	if !exists || raw == nil {
		return nil, nil
	}
	return parseJobManageBashEnvValue(raw)
}

// parseJobManageBashEnvValue reads bash_env as the task stores it, a list of {name, value}
// objects. Errors name the entry, never its value.
func parseJobManageBashEnvValue(raw any) ([]cronstore.BashEnvRef, error) {
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

// jobManageAddLinks is what an add may say beyond the job's schedule.
type jobManageAddLinks struct {
	Triggers []cronstore.Trigger
	Uses     []cronstore.Use
	Join     string
}

// parseJobManageAddLinks reads add_triggers, uses and join for an add: absent or null is none.
// remove_triggers has nothing to remove on a new job.
func parseJobManageAddLinks(params map[string]any) (jobManageAddLinks, error) {
	var links jobManageAddLinks
	if raw, exists := params["remove_triggers"]; exists && raw != nil {
		if ids, err := parseJobManageTriggerIDs(raw); err != nil || len(ids) > 0 {
			return links, fmt.Errorf("remove_triggers is for update: a new job has no triggers to remove")
		}
	}
	if raw, exists := params["add_triggers"]; exists && raw != nil {
		triggers, err := parseJobManageTriggers(raw)
		if err != nil {
			return links, err
		}
		links.Triggers = triggers
	}
	if raw, exists := params["uses"]; exists && raw != nil {
		uses, err := parseJobManageUses(raw)
		if err != nil {
			return links, err
		}
		links.Uses = uses
	}
	join, err := parseJobManageOptionalString(params, "join")
	if err != nil {
		return links, err
	}
	links.Join = join
	return links, nil
}

// jobManageObjects reads a parameter that is an array of objects whose fields are all strings
// among allowed.
func jobManageObjects(name string, raw any, shape string, allowed ...string) ([]map[string]string, error) {
	if typed, ok := raw.([]map[string]any); ok {
		items := make([]any, len(typed))
		for i := range typed {
			items[i] = typed[i]
		}
		raw = items
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("%s must be an array of %s objects", name, shape)
	}
	out := make([]map[string]string, 0, len(items))
	for i, item := range items {
		entry, ok := item.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s must be an array of %s objects; %s[%d] is not an object", name, shape, name, i)
		}
		fields := make(map[string]string, len(entry))
		for key, value := range entry {
			known := false
			for _, field := range allowed {
				known = known || field == key
			}
			if !known {
				return nil, fmt.Errorf("%s[%d] has an unknown field %q (want %s)", name, i, key, strings.Join(allowed, ", "))
			}
			if value == nil {
				continue
			}
			text, ok := value.(string)
			if !ok {
				return nil, fmt.Errorf("%s[%d].%s must be a string", name, i, key)
			}
			fields[key] = strings.TrimSpace(text)
		}
		out = append(out, fields)
	}
	return out, nil
}

// parseJobManageTriggers reads add_triggers. A new trigger's ID is always generated. What each
// kind needs is checked when the job is saved, with the errors every save gives.
func parseJobManageTriggers(raw any) ([]cronstore.Trigger, error) {
	if typed, ok := raw.([]cronstore.Trigger); ok {
		return append([]cronstore.Trigger{}, typed...), nil
	}
	items, err := jobManageObjects("add_triggers", raw, `{"kind": ...}`, "kind", "at", "cron", "tz", "channel", "chat_id")
	if err != nil {
		return nil, err
	}
	triggers := make([]cronstore.Trigger, 0, len(items))
	for i, item := range items {
		if item["kind"] == "" {
			return nil, fmt.Errorf("add_triggers[%d].kind is required (schedule, poke or message)", i)
		}
		triggers = append(triggers, cronstore.Trigger{Kind: item["kind"], At: item["at"], Cron: item["cron"], TZ: item["tz"],
			Channel: item["channel"], ChatID: item["chat_id"]})
	}
	return triggers, nil
}

// parseJobManageTriggerIDs reads remove_triggers, a list of trigger IDs.
func parseJobManageTriggerIDs(raw any) ([]string, error) {
	if typed, ok := raw.([]string); ok {
		return append([]string{}, typed...), nil
	}
	items, ok := raw.([]any)
	if !ok {
		return nil, fmt.Errorf("remove_triggers must be an array of trigger ids")
	}
	ids := make([]string, 0, len(items))
	for i, item := range items {
		id, ok := item.(string)
		if !ok || strings.TrimSpace(id) == "" {
			return nil, fmt.Errorf("remove_triggers[%d] must be a trigger id", i)
		}
		ids = append(ids, strings.TrimSpace(id))
	}
	return ids, nil
}

// parseJobManageUses reads uses as the job stores it. Modes, ages and the jobs named are checked
// when the job is saved.
func parseJobManageUses(raw any) ([]cronstore.Use, error) {
	if typed, ok := raw.([]cronstore.Use); ok {
		return append([]cronstore.Use{}, typed...), nil
	}
	items, err := jobManageObjects("uses", raw, `{"job_id": ..., "mode": ...}`, "job_id", "mode", "max_age")
	if err != nil {
		return nil, err
	}
	uses := make([]cronstore.Use, 0, len(items))
	for _, item := range items {
		uses = append(uses, cronstore.Use{JobID: item["job_id"], Mode: item["mode"], MaxAge: item["max_age"]})
	}
	return uses, nil
}
