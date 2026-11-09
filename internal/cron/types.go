package cron

import (
	"strings"
	"time"
)

const (
	DefaultFilename           = "cron.yaml"
	DefaultTaskTitle          = "Unititled TODO"
	ConsoleNotificationChatID = "console:user"
	Version                   = 1

	TimestampLayout = "2006-01-02 15:04"
)

func IsConsoleNotificationChatID(chatID string) bool {
	return strings.EqualFold(strings.TrimSpace(chatID), ConsoleNotificationChatID)
}

type File struct {
	Version int    `yaml:"version"`
	Tasks   []Task `yaml:"tasks"`
}

type Task struct {
	ID         string `yaml:"id" json:"id"`
	Title      string `yaml:"title,omitempty" json:"title,omitempty"`
	Enabled    *bool  `yaml:"enabled,omitempty" json:"enabled,omitempty"`
	At         string `yaml:"at,omitempty" json:"at,omitempty"`
	Cron       string `yaml:"cron,omitempty" json:"cron,omitempty"`
	TZ         string `yaml:"tz,omitempty" json:"tz,omitempty"`
	Content    string `yaml:"content" json:"content"`
	ChatID     string `yaml:"chat_id,omitempty" json:"chat_id,omitempty"`
	Mention    string `yaml:"mention,omitempty" json:"mention,omitempty"`
	LLMProfile string `yaml:"llm_profile,omitempty" json:"llm_profile,omitempty"`
	// WorkspaceDir, when set, is the workspace attached to this task's runs instead of the
	// runtime default.
	WorkspaceDir string       `yaml:"workspace_dir,omitempty" json:"workspace_dir,omitempty"`
	BashEnv      []BashEnvRef `yaml:"bash_env,omitempty" json:"bash_env,omitempty"`
	// LastRunAt is when the scheduler last started the task (RFC 3339), and LastRunStatus how
	// that run ended: "", "done" or "failed". They are kept by the store, not written by clients,
	// and are not part of cron.yaml.
	LastRunAt     string `yaml:"-" json:"last_run_at,omitempty"`
	LastRunStatus string `yaml:"-" json:"last_run_status,omitempty"`
}

// Run statuses in LastRunStatus.
const (
	RunStatusDone   = "done"
	RunStatusFailed = "failed"
)

type DueTask struct {
	Task           Task
	ScheduledAtUTC time.Time
	Manual         bool
}

type AddResult struct {
	OK        bool     `json:"ok"`
	Action    string   `json:"action"`
	TaskCount int      `json:"task_count"`
	Task      *Task    `json:"task,omitempty"`
	Warnings  []string `json:"warnings,omitempty"`
}

type DeleteResult struct {
	OK        bool   `json:"ok"`
	Action    string `json:"action"`
	TaskCount int    `json:"task_count"`
	Deleted   *Task  `json:"deleted,omitempty"`
}

func ScheduleForTask(task Task) string {
	if at := strings.TrimSpace(task.At); at != "" {
		return at
	}
	return strings.TrimSpace(task.Cron)
}

func TaskEnabled(task Task) bool {
	return task.Enabled == nil || *task.Enabled
}

func normalizeTaskTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return DefaultTaskTitle
	}
	return title
}
