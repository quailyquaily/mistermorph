package cron

import (
	"fmt"
	"strings"
)

// TaskPatch is a partial edit of a stored task. A nil field is left as it is; a set field is
// written, an empty string clearing it. BashEnv set to an empty list clears the task's bash_env.
//
// RemoveTriggers names triggers to take out by ID, and AddTriggers are put after the ones that
// stay (one without an ID gets one). Uses, when set, replaces the task's whole uses list (an empty
// list clears it), and Join its join ("" is the default, all).
type TaskPatch struct {
	Title        *string
	Content      *string
	At           *string
	Cron         *string
	TZ           *string
	ChatID       *string
	WorkspaceDir *string
	BashEnv      *[]BashEnvRef

	RemoveTriggers []string
	AddTriggers    []Trigger
	Uses           *[]Use
	Join           *string
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
		p.ChatID == nil && p.WorkspaceDir == nil && p.BashEnv == nil &&
		len(p.RemoveTriggers) == 0 && len(p.AddTriggers) == 0 && p.Uses == nil && p.Join == nil
}

// apply returns task with the patch's fields written, and the names of those fields. Setting a
// non-empty at without cron clears cron, and a non-empty cron without at clears at, so a task
// switches between one-time and recurring with one field. Removing a trigger the task does not
// have is an error. After a change to the trigger list, at, cron and tz are again those of the
// first schedule trigger (empty without one).
func (p TaskPatch) apply(task Task) (Task, []string, error) {
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
	if task.Triggers != nil && (p.At != nil || p.Cron != nil || p.TZ != nil) {
		// at, cron and tz are the first schedule trigger's; the job's other triggers stay.
		task.Triggers = withLegacySchedule(task.Triggers, task.At, task.Cron, task.TZ)
	}
	set("chat_id", p.ChatID, &task.ChatID)
	set("workspace_dir", p.WorkspaceDir, &task.WorkspaceDir)
	if p.BashEnv != nil {
		task.BashEnv = normalizeBashEnvRefs(*p.BashEnv)
		fields = append(fields, "bash_env")
	}
	if len(p.RemoveTriggers) > 0 || len(p.AddTriggers) > 0 {
		triggers := append([]Trigger{}, TriggersForTask(task)...)
		for _, raw := range p.RemoveTriggers {
			id := strings.TrimSpace(raw)
			at := -1
			for i, trigger := range triggers {
				if trigger.ID == id && id != "" {
					at = i
					break
				}
			}
			if at < 0 {
				return task, nil, fmt.Errorf("task %s has no trigger %q", strings.TrimSpace(task.ID), id)
			}
			triggers = append(triggers[:at], triggers[at+1:]...)
		}
		for _, trigger := range p.AddTriggers {
			triggers = append(triggers, normalizeTrigger(trigger))
		}
		task.Triggers = triggers
		task.At, task.Cron, task.TZ = "", "", ""
		if first, ok := TriggerOfKind(task, TriggerSchedule); ok {
			task.At, task.Cron, task.TZ = first.At, first.Cron, first.TZ
		}
		fields = append(fields, "triggers")
	}
	if p.Uses != nil {
		task.Uses = normalizeUses(*p.Uses)
		fields = append(fields, "uses")
	}
	if p.Join != nil {
		task.Join = strings.ToLower(strings.TrimSpace(*p.Join))
		fields = append(fields, "join")
	}
	return task, fields, nil
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
