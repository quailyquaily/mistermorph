package cron

import "strings"

// TaskPatch is a partial edit of a stored task. A nil field is left as it is; a set field is
// written, an empty string clearing it. BashEnv set to an empty list clears the task's bash_env.
type TaskPatch struct {
	Title        *string
	Content      *string
	At           *string
	Cron         *string
	TZ           *string
	ChatID       *string
	WorkspaceDir *string
	BashEnv      *[]BashEnvRef
}

// UpdateResult is the outcome of Store.Update. Fields names the fields the patch set, in
// cron.yaml terms.
type UpdateResult struct {
	OK        bool     `json:"ok"`
	Action    string   `json:"action"`
	TaskCount int      `json:"task_count"`
	Task      *Task    `json:"task,omitempty"`
	Fields    []string `json:"fields,omitempty"`
}

// IsEmpty reports whether the patch sets no field.
func (p TaskPatch) IsEmpty() bool {
	return p.Title == nil && p.Content == nil && p.At == nil && p.Cron == nil && p.TZ == nil &&
		p.ChatID == nil && p.WorkspaceDir == nil && p.BashEnv == nil
}

// apply returns task with the patch's fields written, and the names of those fields. Setting a
// non-empty at without cron clears cron, and a non-empty cron without at clears at, so a task
// switches between one-time and recurring with one field.
func (p TaskPatch) apply(task Task) (Task, []string) {
	var fields []string
	set := func(name string, value *string, target *string) {
		if value == nil {
			return
		}
		*target = strings.TrimSpace(*value)
		fields = append(fields, name)
	}
	set("title", p.Title, &task.Title)
	task.Title = normalizeTaskTitle(task.Title)
	set("content", p.Content, &task.Content)
	set("at", p.At, &task.At)
	set("cron", p.Cron, &task.Cron)
	if p.At != nil && p.Cron == nil && task.At != "" {
		task.Cron = ""
	}
	if p.Cron != nil && p.At == nil && task.Cron != "" {
		task.At = ""
	}
	set("tz", p.TZ, &task.TZ)
	set("chat_id", p.ChatID, &task.ChatID)
	set("workspace_dir", p.WorkspaceDir, &task.WorkspaceDir)
	if p.BashEnv != nil {
		task.BashEnv = normalizeBashEnvRefs(*p.BashEnv)
		fields = append(fields, "bash_env")
	}
	return task, fields
}

// normalizeBashEnvRefs copies refs with their names trimmed; an empty list is nil, which stores
// as no bash_env.
func normalizeBashEnvRefs(refs []BashEnvRef) []BashEnvRef {
	if len(refs) == 0 {
		return nil
	}
	out := make([]BashEnvRef, len(refs))
	for i, ref := range refs {
		out[i] = BashEnvRef{Name: strings.TrimSpace(ref.Name), Value: ref.Value}
	}
	return out
}
