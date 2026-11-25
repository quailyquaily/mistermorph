package agent

import (
	"context"
	"strings"
)

// Child steering: the person can send a message straight to a child a task started with spawn,
// while it runs. The runtime that runs the task puts a ChildSteerHub in the task's context; every
// subtask the task starts, at any depth, registers with it as it starts and leaves as it returns.
// The hub gives an agent child a steer source of its own, which its engine drains at its next step
// (never in the middle of a model call or a tool), as the task's own run drains the task's.
// A child that runs a function instead of an agent (a coder, a shell command) registers too, so
// that a message for it is refused rather than reported unknown; it gets no source.

// Kinds of child (ChildSteerTarget.Kind).
const (
	// ChildKindSubagent is an agent started by spawn: it takes messages.
	ChildKindSubagent = "subagent"
	// ChildKindExternal is a child that runs a function (a coder's CLI, a shell command): it
	// cannot take a message while it runs.
	ChildKindExternal = "external"
)

// ChildSteerTarget is a child as it registers with its task's ChildSteerHub.
type ChildSteerTarget struct {
	// TaskID is the child's subtask ID, which is also its run ID.
	TaskID string
	// ParentRunID is the run that started it: the task's own, or another child's.
	ParentRunID string
	// Worker is the child's identity in its task (its ID, such as "worker-2", and its name).
	Worker *WorkerMetadata
	// Kind is ChildKindSubagent or ChildKindExternal.
	Kind string
	// Task is what the child was asked.
	Task string
	// Sink receives the events the hub reports about messages for the child.
	Sink EventSink
}

// ChildSteerHub keeps the steer sources of a task's running children.
type ChildSteerHub interface {
	// OpenChild registers a child that starts now.
	OpenChild(ctx context.Context, child ChildSteerTarget) ChildSteerLease
}

// ChildSteerLease is a child's registration with its hub.
type ChildSteerLease interface {
	// Source feeds the child's run the messages sent to it; nil for a child that takes none.
	Source() SteerSource
	// Finish marks the child returned, and returns the messages it took in, in order. A message
	// still waiting when it returns is not lost: the hub reports it as not applied.
	Finish() []string
}

// SteerStepRecorder is implemented by a SteerSource that is told at which step the run took the
// items it drained in.
type SteerStepRecorder interface {
	SteerApplied(step int, texts []string)
}

type childSteerHubKey struct{}

// WithChildSteerHub gives a task's run, and every subtask it starts, the hub children register with.
func WithChildSteerHub(ctx context.Context, hub ChildSteerHub) context.Context {
	if hub == nil {
		return ctx
	}
	if ctx == nil {
		ctx = context.Background()
	}
	return context.WithValue(ctx, childSteerHubKey{}, hub)
}

// ChildSteerHubFromContext returns the hub of the task ctx belongs to, if its runtime keeps one.
func ChildSteerHubFromContext(ctx context.Context) ChildSteerHub {
	if ctx == nil {
		return nil
	}
	hub, _ := ctx.Value(childSteerHubKey{}).(ChildSteerHub)
	return hub
}

// OpenSubtaskSteer registers the subtask taskID that runs in runCtx with meta (both from
// PrepareSubtaskContext) with its task's hub. It returns the source to run the subtask's agent with (nil when there is no
// hub, or for a subtask that runs a function), and the function that ends the registration once
// the subtask returns, marking the result of a subtask the person redirected.
func OpenSubtaskSteer(runCtx context.Context, taskID string, meta map[string]any, req SubtaskRequest) (SteerSource, func(*SubtaskResult)) {
	hub := ChildSteerHubFromContext(runCtx)
	if hub == nil {
		return nil, func(*SubtaskResult) {}
	}
	kind := ChildKindSubagent
	if req.RunFunc != nil {
		kind = ChildKindExternal
	}
	sink, _ := EventSinkFromContext(runCtx)
	parentRunID, _ := meta["subtask_parent_run_id"].(string)
	lease := hub.OpenChild(runCtx, ChildSteerTarget{
		TaskID:      strings.TrimSpace(taskID),
		ParentRunID: strings.TrimSpace(parentRunID),
		Worker:      WorkerFromContext(runCtx),
		Kind:        kind,
		Task:        strings.TrimSpace(req.Task),
		Sink:        sink,
	})
	if lease == nil {
		return nil, func(*SubtaskResult) {}
	}
	var source SteerSource
	if kind == ChildKindSubagent {
		source = lease.Source()
	}
	return source, func(result *SubtaskResult) {
		MarkRedirectedSubtaskResult(result, lease.Finish())
	}
}

// SubtaskRedirectedNote tells the agent that started a subtask how to read the result of one the
// person sent messages to.
const SubtaskRedirectedNote = "The user sent this subtask the messages in user_messages directly while it ran, and it followed them. " +
	"Where its result differs from the task you gave it, that is the user's redirection, not a fault: do not retry it or treat the change as an error."

// MarkRedirectedSubtaskResult records on result the messages the person sent its subtask that the
// subtask took in, so the agent that started it reads a changed result as the person's.
func MarkRedirectedSubtaskResult(result *SubtaskResult, messages []string) {
	if result == nil {
		return
	}
	kept := make([]string, 0, len(messages))
	for _, message := range messages {
		if text := strings.TrimSpace(message); text != "" {
			kept = append(kept, text)
		}
	}
	if len(kept) == 0 {
		return
	}
	result.UserMessages = append(result.UserMessages, kept...)
	result.Note = SubtaskRedirectedNote
}
