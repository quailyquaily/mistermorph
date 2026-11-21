package cron

import (
	"strings"
	"time"

	"github.com/quailyquaily/mistermorph/internal/awareness"
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
	// Triggers are the ways the job starts (see Trigger). A stored job always has the list, empty
	// when nothing starts it but a person. At, Cron and TZ above mirror its first schedule trigger,
	// for clients that know only those. A task written without the list (nil) is a legacy write:
	// At, Cron and TZ are its schedule, as they always were. In JSON a stored job always shows the
	// list ("triggers": [] when empty); only a task that has none (nil) leaves the key out.
	Triggers []Trigger `yaml:"triggers,omitempty" json:"triggers,omitzero"`
	// Uses are the jobs this one depends on, and Join how several "each" inputs combine: JoinAll
	// (the default, also "") or JoinAny.
	Uses []Use  `yaml:"uses,omitempty" json:"uses,omitempty"`
	Join string `yaml:"join,omitempty" json:"join,omitempty"`
	// LastRunAt is when the scheduler last started the task (RFC 3339), and LastRunStatus how
	// that run ended: "", "done", "failed" or "canceled" (stopped by a person). They are kept by the store, not written by clients,
	// and are not part of cron.yaml.
	LastRunAt     string `yaml:"-" json:"last_run_at,omitempty"`
	LastRunStatus string `yaml:"-" json:"last_run_status,omitempty"`
}

// Run statuses: how a run ended (LastRunStatus holds one of the first three).
const (
	RunStatusDone     = "done"
	RunStatusFailed   = "failed"
	RunStatusCanceled = "canceled"
)

type DueTask struct {
	Task           Task
	ScheduledAtUTC time.Time
	Manual         bool
	// RunID names this one execution of the task (see RunBoard.Queue); empty outside a cron loop.
	RunID string
	// Cause is why the run starts. A zero cause is a schedule's, or a person's when Manual is set.
	Cause RunCause
	// Input is the body of the request that started the run (a per-job poke), given to the run as
	// source data, never as instructions.
	Input awareness.PokeInput
	// ChainDepth is the run's place in its chain of jobs: 1 for the run that starts one.
	ChainDepth int
}

// RunRequest asks a cron loop to run Task now. A zero Cause is a person's (CauseManual).
type RunRequest struct {
	Task  Task
	Cause RunCause
	Input awareness.PokeInput
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
