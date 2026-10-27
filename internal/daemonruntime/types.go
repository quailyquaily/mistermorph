package daemonruntime

import (
	"context"
	"encoding/json"
	"time"

	"github.com/quailyquaily/mistermorph/internal/taskdomain"
)

type TaskStatus = taskdomain.TaskStatus

const (
	TaskQueued   = taskdomain.TaskQueued
	TaskRunning  = taskdomain.TaskRunning
	TaskPending  = taskdomain.TaskPending
	TaskDone     = taskdomain.TaskDone
	TaskFailed   = taskdomain.TaskFailed
	TaskCanceled = taskdomain.TaskCanceled
)

type SubmitTaskRequest struct {
	Task           string          `json:"task"`
	Model          string          `json:"model,omitempty"`
	LLMProfile     string          `json:"llm_profile,omitempty"`
	Timeout        string          `json:"timeout,omitempty"` // time.ParseDuration; optional
	TopicID        string          `json:"topic_id,omitempty"`
	TopicTitle     string          `json:"topic_title,omitempty"`
	WorkspaceDir   string          `json:"workspace_dir,omitempty"`
	FileReferences []FileReference `json:"file_references,omitempty"`
	Trigger        *TaskTrigger    `json:"trigger,omitempty"`
}

type FileReference = taskdomain.FileReference

type SubmitTaskResponse struct {
	ID                string     `json:"id"`
	Status            TaskStatus `json:"status"`
	TopicID           string     `json:"topic_id,omitempty"`
	SteerTargetTaskID string     `json:"steer_target_task_id,omitempty"`
}

type CreateTopicRequest struct {
	Title string `json:"title,omitempty"`
}

type StopTaskRequest struct {
	TaskID  string `json:"task_id,omitempty"`
	TopicID string `json:"topic_id,omitempty"`
	Reason  string `json:"reason,omitempty"`
}

// AnswerQuestionRequest answers question QuestionID of task TaskID: with typed Text when set,
// otherwise with its choice at Option.
type AnswerQuestionRequest struct {
	TaskID     string `json:"-"`
	QuestionID string `json:"question_id"`
	Option     int    `json:"option"`
	Text       string `json:"text,omitempty"`
}

// AnswerElevationRequest answers approval ElevationID of task TaskID: a decline, or the sudo
// password (docs/feat/feat_20261026_elevation_client_approval.md). The password is protected by
// the connection alone: HTTPS, loopback, an SSH tunnel or a VPN.
type AnswerElevationRequest struct {
	TaskID      string `json:"-"`
	ElevationID string `json:"elevation_id"`
	Decline     bool   `json:"decline,omitempty"`
	Password    string `json:"password,omitempty"`
	// Client is "web", "desktop" or "chat", as the client says, for the audit log.
	Client string `json:"client,omitempty"`
	// Transport is "secure" (every hop HTTPS or loopback) or "insecure", from the connection the
	// answer came on; Remote is the client's address. The server sets them, never the client.
	Transport string `json:"-"`
	Remote    string `json:"-"`
}

type AnswerElevationResponse struct {
	// Accepted is false when the approval is no longer open: answered, expired, or its task ended.
	Accepted bool `json:"accepted"`
}

type AnswerQuestionResponse struct {
	// Answered is false when the question is no longer open: answered, expired, or its task ended.
	Answered bool   `json:"answered"`
	Answer   string `json:"answer,omitempty"`
}

type StopTaskResponse struct {
	Status   string `json:"status"`
	Found    bool   `json:"found"`
	TaskID   string `json:"task_id,omitempty"`
	TopicID  string `json:"topic_id,omitempty"`
	Progress string `json:"progress,omitempty"`
	Message  string `json:"message,omitempty"`
}

type ApprovalListFunc func(ctx context.Context, req ApprovalListRequest) (ApprovalListResponse, error)
type ApprovalGetFunc func(ctx context.Context, approvalRequestID string) (ApprovalInfo, bool, error)
type ApprovalDecisionFunc func(ctx context.Context, req ApprovalDecisionRequest) (ApprovalDecisionResponse, error)

type ApprovalListRequest struct {
	Status string
	Limit  int
}

type ApprovalInfo struct {
	ApprovalRequestID     string         `json:"approval_request_id"`
	TaskID                string         `json:"task_id,omitempty"`
	RunID                 string         `json:"run_id,omitempty"`
	Status                string         `json:"status"`
	ToolName              string         `json:"tool_name,omitempty"`
	ToolParams            map[string]any `json:"tool_params,omitempty"`
	ActionSummaryRedacted string         `json:"action_summary_redacted,omitempty"`
	Reasons               []string       `json:"reasons,omitempty"`
	Runtime               string         `json:"runtime,omitempty"`
	Target                string         `json:"target,omitempty"`
	TopicID               string         `json:"topic_id,omitempty"`
	CreatedAt             time.Time      `json:"created_at"`
	ExpiresAt             time.Time      `json:"expires_at"`
	PendingAt             *time.Time     `json:"pending_at,omitempty"`
	// SkillPreview is, for a skill_install call, the preview it would install (skillinstall.Preview):
	// source, review, every risk and the files. Absent when that preview has expired.
	SkillPreview json.RawMessage `json:"skill_preview,omitempty"`
}

type ApprovalListResponse struct {
	Items []ApprovalInfo `json:"items"`
	Limit int            `json:"limit,omitempty"`
}

type ApprovalDecisionRequest struct {
	ApprovalRequestID string `json:"approval_request_id,omitempty"`
	Actor             string `json:"actor,omitempty"`
	Note              string `json:"note,omitempty"`
}

type ApprovalDecisionResponse struct {
	ApprovalRequestID string `json:"approval_request_id"`
	TaskID            string `json:"task_id,omitempty"`
	Status            string `json:"status"`
	Resumed           bool   `json:"resumed"`
	Error             string `json:"error,omitempty"`
}

type TaskInfo = taskdomain.TaskInfo

type TaskTrigger = taskdomain.TaskTrigger

type TopicInfo = taskdomain.TopicInfo

const (
	ConsoleDefaultTopicID      = "default"
	ConsoleDefaultTopicTitle   = "Default"
	ConsoleAwarenessTopicID    = "_awareness"
	ConsoleAwarenessTopicTitle = "Awareness"
)
