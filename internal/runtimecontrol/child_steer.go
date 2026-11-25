package runtimecontrol

import (
	"context"
	"strings"
	"sync"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
)

// Why a message for a child of a running task was not queued (ChildSteerResult.Reason), besides
// SteerRejectedStopping and SteerRejectedFull.
const (
	// SteerRejectedNoRun: the conversation has no task running.
	SteerRejectedNoRun = "no_active_run"
	// SteerRejectedChildNotFound: the running task has no child with that ID.
	SteerRejectedChildNotFound = "child_not_found"
	// SteerRejectedChildFinished: the child has already returned to the agent that started it.
	SteerRejectedChildFinished = "child_finished"
	// SteerRejectedChildUnsupported: the child runs an external program (a coder's CLI, a shell
	// command), which cannot take a message while it runs.
	SteerRejectedChildUnsupported = "child_unsupported"
	// SteerRejectedEmpty: the message has no text.
	SteerRejectedEmpty = "empty"
)

// What became of a message sent to a child (ChildMessage.Status).
const (
	ChildMessageQueued  = "queued"
	ChildMessageApplied = "applied"
	// ChildMessageDropped: the child returned, or the task was stopped, before it took the message in.
	ChildMessageDropped = "dropped"
)

// childMessageLimit bounds the messages a task's ChildSteering keeps in its log.
const childMessageLimit = 64

// EventKindSteerDropped reports a message queued for a child that returned (or was stopped)
// before it took the message in.
const EventKindSteerDropped = "steer_dropped"

// ChildMessage is one message the person sent a child of a task, and what became of it.
type ChildMessage struct {
	// ChildID is the child's worker ID in its task ("worker-2"); ChildTaskID its subtask ID.
	ChildID     string `json:"child_id"`
	ChildTaskID string `json:"child_task_id"`
	ChildName   string `json:"child_name,omitempty"`
	// ParentRunID is the run that started the child: the task's own, or another child's.
	ParentRunID string     `json:"parent_run_id,omitempty"`
	Text        string     `json:"text"`
	Status      string     `json:"status"`
	QueuedAt    time.Time  `json:"queued_at"`
	AppliedAt   *time.Time `json:"applied_at,omitempty"`
	// Step is the child's step (counted from 1) whose model request first saw the message.
	Step int `json:"step,omitempty"`
}

// ChildSteerResult is what became of a message sent to a child of a running task.
type ChildSteerResult struct {
	// Found is set when the conversation had a task running.
	Found bool `json:"found"`
	// Queued is set when the message waits for the child's next step.
	Queued bool `json:"queued"`
	// Reason says why a message was not queued: one of the SteerRejected* reasons.
	Reason string `json:"reason,omitempty"`
	// TaskID is the running task's.
	TaskID      string `json:"task_id,omitempty"`
	ChildID     string `json:"child_id,omitempty"`
	ChildTaskID string `json:"child_task_id,omitempty"`
	ChildName   string `json:"child_name,omitempty"`
	ParentRunID string `json:"parent_run_id,omitempty"`
	// Pending counts the messages waiting for the child, this one included.
	Pending int `json:"pending,omitempty"`
}

// ChildSteering keeps the steer queues of the children a task started with spawn, at any depth,
// while the task runs (agent.ChildSteerHub). A child stays known after it returns, so a message
// sent to it then is refused as finished, never lost or taken for an unknown one. It logs every
// message sent to a child with what became of it, for the task's record.
type ChildSteering struct {
	mu       sync.Mutex
	children []*steerChild
	log      []*ChildMessage
	now      func() time.Time
}

type steerChild struct {
	hub         *ChildSteering
	taskID      string
	workerID    string
	name        string
	parentRunID string
	kind        string
	worker      *agent.WorkerMetadata
	sink        agent.EventSink
	queue       *SteerQueue
	finished    bool
}

// NewChildSteering returns an empty registry.
func NewChildSteering() *ChildSteering {
	return &ChildSteering{now: time.Now}
}

// OpenChild registers a child that starts now (agent.ChildSteerHub).
func (h *ChildSteering) OpenChild(_ context.Context, target agent.ChildSteerTarget) agent.ChildSteerLease {
	if h == nil {
		return nil
	}
	child := &steerChild{
		hub:         h,
		taskID:      strings.TrimSpace(target.TaskID),
		parentRunID: strings.TrimSpace(target.ParentRunID),
		kind:        strings.TrimSpace(target.Kind),
		sink:        target.Sink,
	}
	if target.Worker != nil {
		worker := *target.Worker
		worker.Processes = nil
		child.worker = &worker
		child.workerID = strings.TrimSpace(worker.ID)
		child.name = strings.TrimSpace(worker.Name)
	}
	if child.kind == agent.ChildKindSubagent {
		child.queue = NewSteerQueue(0)
	}
	h.mu.Lock()
	h.children = append(h.children, child)
	h.mu.Unlock()
	return child
}

// Source is the child's steer source; nil for a child that takes no messages.
func (c *steerChild) Source() agent.SteerSource {
	if c == nil || c.queue == nil {
		return nil
	}
	return &childSteerSource{child: c}
}

// Finish marks the child returned and returns the messages it took in. Messages still queued are
// reported dropped.
func (c *steerChild) Finish() []string {
	if c == nil || c.hub == nil {
		return nil
	}
	if c.queue != nil {
		// The engine closed it already; closing again resolves anything pushed meanwhile.
		c.queue.Close()
	}
	h := c.hub
	h.mu.Lock()
	c.finished = true
	var applied []string
	var dropped []ChildMessage
	for _, message := range h.log {
		if message.ChildTaskID != c.taskID {
			continue
		}
		switch message.Status {
		case ChildMessageApplied:
			applied = append(applied, message.Text)
		case ChildMessageQueued:
			message.Status = ChildMessageDropped
			dropped = append(dropped, *message)
		}
	}
	h.mu.Unlock()
	for _, message := range dropped {
		c.emit(EventKindSteerDropped, message)
	}
	return applied
}

func (c *steerChild) emit(kind string, message ChildMessage) {
	if c == nil || c.sink == nil {
		return
	}
	var worker *agent.WorkerMetadata
	if c.worker != nil {
		copied := *c.worker
		worker = &copied
	}
	event := agent.Event{
		Kind:       kind,
		Worker:     worker,
		RunID:      c.taskID,
		TaskID:     c.taskID,
		ActivityID: "steer",
		Status:     message.Status,
		Step:       message.Step,
		Text:       message.Text,
		Args: map[string]any{
			"target":        "child",
			"child_id":      c.workerID,
			"child_task_id": c.taskID,
			"parent_run_id": c.parentRunID,
		},
	}
	agent.EmitEvent(context.Background(), c.sink, event)
}

// childSteerSource is a child's queue as its engine drains it; it records the step at which the
// child took each message in.
type childSteerSource struct {
	child *steerChild
}

func (s *childSteerSource) Drain() []string         { return s.child.queue.Drain() }
func (s *childSteerSource) DrainAndClose() []string { return s.child.queue.DrainAndClose() }
func (s *childSteerSource) Close()                  { s.child.queue.Close() }

// SteerApplied marks the child's oldest queued messages, one per text, applied at step.
func (s *childSteerSource) SteerApplied(step int, texts []string) {
	c := s.child
	h := c.hub
	at := h.now().UTC()
	h.mu.Lock()
	remaining := len(texts)
	for _, message := range h.log {
		if remaining == 0 {
			break
		}
		if message.ChildTaskID != c.taskID || message.Status != ChildMessageQueued {
			continue
		}
		message.Status = ChildMessageApplied
		message.Step = step
		applied := at
		message.AppliedAt = &applied
		remaining--
	}
	h.mu.Unlock()
}

// find returns the child with ID id: its worker ID ("worker-2") or its subtask ID. The latest
// registered wins, should a worker ID repeat.
func (h *ChildSteering) find(id string) *steerChild {
	id = strings.TrimSpace(id)
	if h == nil || id == "" {
		return nil
	}
	for i := len(h.children) - 1; i >= 0; i-- {
		child := h.children[i]
		if child.workerID == id || child.taskID == id {
			return child
		}
	}
	return nil
}

// steer queues input for child id; taskID is the running task's.
func (h *ChildSteering) steer(taskID string, id string, input string) ChildSteerResult {
	result := ChildSteerResult{Found: true, TaskID: strings.TrimSpace(taskID)}
	input = strings.TrimSpace(input)
	if input == "" {
		result.Reason = SteerRejectedEmpty
		return result
	}
	if h == nil {
		result.Reason = SteerRejectedChildNotFound
		return result
	}
	h.mu.Lock()
	child := h.find(id)
	if child == nil {
		h.mu.Unlock()
		result.Reason = SteerRejectedChildNotFound
		return result
	}
	result.ChildID, result.ChildTaskID, result.ChildName, result.ParentRunID = child.workerID, child.taskID, child.name, child.parentRunID
	switch {
	case child.kind != agent.ChildKindSubagent || child.queue == nil:
		h.mu.Unlock()
		result.Reason = SteerRejectedChildUnsupported
		return result
	case child.finished:
		h.mu.Unlock()
		result.Reason = SteerRejectedChildFinished
		return result
	}
	_, pending, err := child.queue.PushTicket(input)
	if err != nil {
		h.mu.Unlock()
		result.Reason = SteerRejectedChildFinished
		if err == ErrSteerQueueFull {
			result.Reason = SteerRejectedFull
		}
		return result
	}
	message := &ChildMessage{
		ChildID:     child.workerID,
		ChildTaskID: child.taskID,
		ChildName:   child.name,
		ParentRunID: child.parentRunID,
		Text:        input,
		Status:      ChildMessageQueued,
		QueuedAt:    h.now().UTC(),
	}
	h.log = append(h.log, message)
	if extra := len(h.log) - childMessageLimit; extra > 0 {
		h.log = append([]*ChildMessage(nil), h.log[extra:]...)
	}
	// Reported before the lock is let go: the child takes the message in (and reports it applied)
	// only after SteerApplied gets the lock, so the reports keep their order.
	child.emit(agent.EventKindSteerQueued, *message)
	h.mu.Unlock()
	result.Queued, result.Pending = true, pending
	return result
}

// Messages returns the messages sent to the task's children so far, oldest first, with what
// became of each.
func (h *ChildSteering) Messages() []ChildMessage {
	if h == nil {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	out := make([]ChildMessage, 0, len(h.log))
	for _, message := range h.log {
		copied := *message
		if message.AppliedAt != nil {
			at := *message.AppliedAt
			copied.AppliedAt = &at
		}
		out = append(out, copied)
	}
	return out
}

// SteerChild queues input for the child childID (its worker ID or subtask ID, at any depth) of the
// task running in the conversation; the child takes it in at its next step.
func (c *RunControl) SteerChild(runtime string, conversationKey string, childID string, input string) ChildSteerResult {
	key, err := keyFrom(runtime, conversationKey)
	if c == nil || err != nil {
		return ChildSteerResult{Reason: SteerRejectedNoRun}
	}
	c.mu.Lock()
	entry := c.active[key]
	if entry == nil {
		c.mu.Unlock()
		return ChildSteerResult{Reason: SteerRejectedNoRun}
	}
	taskID := strings.TrimSpace(entry.TaskID)
	if entry.stopRequested {
		c.mu.Unlock()
		return ChildSteerResult{Found: true, TaskID: taskID, Reason: SteerRejectedStopping}
	}
	children := entry.Children
	c.mu.Unlock()
	return children.steer(taskID, childID, input)
}

// ChildSteerRejectedText says why a message for a child was not queued, for the person who sent it.
func ChildSteerRejectedText(result ChildSteerResult) string {
	name := strings.TrimSpace(result.ChildName)
	if name == "" {
		name = strings.TrimSpace(result.ChildID)
	}
	if name == "" {
		name = "That subagent"
	}
	switch result.Reason {
	case SteerRejectedNoRun:
		return "No task is running, so there is no subagent to send this to. Send it as a new message instead."
	case SteerRejectedChildNotFound:
		return "The running task has no subagent with that ID. Use /agents to see its subagents."
	case SteerRejectedChildFinished:
		return name + " has already finished, so your message was not sent. Send it to the main agent instead."
	case SteerRejectedChildUnsupported:
		return name + " runs an external coding CLI, which cannot take messages while it runs."
	case SteerRejectedStopping:
		return "The task is stopping, so your message was not sent."
	case SteerRejectedFull:
		return name + " already has too many messages waiting. Wait for it to take them in, then send again."
	case SteerRejectedEmpty:
		return "The message is empty."
	}
	return "Your message could not be sent."
}
