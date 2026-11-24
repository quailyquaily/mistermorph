package consolecmd

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/chathistory"
	"github.com/quailyquaily/mistermorph/internal/daemonruntime"
	"github.com/quailyquaily/mistermorph/internal/runtimecontrol"
)

func TestConsoleSteersAMessageToARunningChild(t *testing.T) {
	f := newConsoleSteerFixture(t)
	var events []agent.Event
	sink := agent.EventSinkFunc(func(_ context.Context, event agent.Event) { events = append(events, event) })
	child := f.lease.Children.OpenChild(context.Background(), agent.ChildSteerTarget{
		TaskID: "sub_curie", ParentRunID: "task_active", Kind: agent.ChildKindSubagent, Sink: sink,
		Worker: &agent.WorkerMetadata{ID: "worker-2", Name: "Curie"},
	})
	coder := f.lease.Children.OpenChild(context.Background(), agent.ChildSteerTarget{
		TaskID: "sub_codex", Kind: agent.ChildKindExternal, Worker: &agent.WorkerMetadata{ID: "worker-3", Name: "Turing"},
	})
	defer coder.Finish()

	// A slash is text for the child, not a command; nothing goes to the parent or the topic.
	resp, err := f.rt.submitTask(context.Background(), daemonruntime.SubmitTaskRequest{Task: "/reset your plan: use metric units", TopicID: f.topicID, SteerTargetChildID: "worker-2"})
	if err != nil {
		t.Fatalf("submitTask() error = %v", err)
	}
	if resp.ID != "task_active" || resp.SteerTargetTaskID != "task_active" || resp.SteerTargetChildID != "worker-2" ||
		resp.SteerTargetChildTaskID != "sub_curie" || resp.SteerTargetChildName != "Curie" || resp.SteerStatus != "queued" || resp.Status != daemonruntime.TaskRunning {
		t.Fatalf("submit response = %+v", resp)
	}
	if items := child.Source().Drain(); len(items) != 1 || items[0] != "/reset your plan: use metric units" {
		t.Fatalf("child queue = %q", items)
	}
	if items := f.lease.SteerQueue.Drain(); len(items) != 0 {
		t.Fatalf("the parent got the child's message: %q", items)
	}
	if tasks := f.store.List(daemonruntime.TaskListOptions{TopicID: f.topicID, Limit: 10}); len(tasks) != 2 {
		t.Fatalf("topic tasks = %d, want no task for the child's message", len(tasks))
	}
	if len(events) != 1 || events[0].Kind != agent.EventKindSteerQueued || events[0].Worker.ID != "worker-2" {
		t.Fatalf("events = %+v, want the message reported queued for worker-2", events)
	}

	for _, tc := range []struct {
		child, code string
	}{
		{"worker-3", runtimecontrol.SteerRejectedChildUnsupported},
		{"worker-9", runtimecontrol.SteerRejectedChildNotFound},
	} {
		_, err := f.rt.submitTask(context.Background(), daemonruntime.SubmitTaskRequest{Task: "hello", TopicID: f.topicID, SteerTargetChildID: tc.child})
		var rejected *daemonruntime.SteerRejectedError
		if !errors.As(err, &rejected) || rejected.Code != tc.code || rejected.TaskID != "task_active" || rejected.ChildID != tc.child {
			t.Fatalf("%s: error = %#v, want %s", tc.child, err, tc.code)
		}
	}

	child.Finish()
	_, err = f.rt.submitTask(context.Background(), daemonruntime.SubmitTaskRequest{Task: "one more thing", TopicID: f.topicID, SteerTargetChildID: "worker-2"})
	var rejected *daemonruntime.SteerRejectedError
	if !errors.As(err, &rejected) || rejected.Code != runtimecontrol.SteerRejectedChildFinished || rejected.ChildName != "Curie" || !strings.Contains(rejected.Message, "main agent") {
		t.Fatalf("finished child: error = %#v", err)
	}
	if _, err := f.rt.submitTask(context.Background(), daemonruntime.SubmitTaskRequest{Task: "see [x](job:abc123)", TopicID: f.topicID, SteerTargetChildID: "worker-2"}); err == nil {
		t.Fatal("a job reference was sent to a child")
	}

	f.lease.Finish()
	_, err = f.rt.submitTask(context.Background(), daemonruntime.SubmitTaskRequest{Task: "hello", TopicID: f.topicID, SteerTargetChildID: "worker-2"})
	if !errors.As(err, &rejected) || rejected.Code != runtimecontrol.SteerRejectedNoRun {
		t.Fatalf("no run: error = %#v", err)
	}
}

// The worker's record shows a message queued, then applied at the step its worker took it in, or
// dropped; the record survives a reload.
func TestActivityWorkerRecordsMessagesQueuedThenApplied(t *testing.T) {
	curie := &agent.WorkerMetadata{ID: "worker-1", Name: "Curie"}
	var progress *consoleActivityProgress
	for _, event := range []agent.Event{
		{Kind: agent.EventKindToolStart, ActivityID: "spawn-1", ToolName: "spawn", Status: "running", Worker: curie, Args: map[string]any{"task": "write a haiku"}},
		{Kind: agent.EventKindSubtaskStart, TaskID: "sub_1", Status: "running", Worker: curie},
		// A message to the task itself is not a worker's.
		{Kind: agent.EventKindSteerQueued, TaskID: "task_1", Text: "for the parent"},
	} {
		progress, _ = updateConsoleActivityProgress(progress, event)
	}
	if got := progress.Workers[0].Messages; len(got) != 0 {
		t.Fatalf("messages = %+v, want none", got)
	}
	var changed bool
	progress, changed = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindSteerQueued, RunID: "sub_1", Text: "make it about dogs", Worker: curie})
	if !changed || len(progress.Workers[0].Messages) != 1 || progress.Workers[0].Messages[0].Status != "queued" {
		t.Fatalf("after queued: %+v", progress.Workers[0].Messages)
	}
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindSteerQueued, RunID: "sub_1", Text: "and short", Worker: curie})
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindSteerApplied, RunID: "sub_1", Step: 3, Text: "make it about dogs", Args: map[string]any{"count": 1}, Worker: curie})
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: runtimecontrol.EventKindSteerDropped, RunID: "sub_1", Text: "and short", Worker: curie})
	raw, err := json.Marshal(progress)
	if err != nil {
		t.Fatal(err)
	}
	var loaded consoleActivityProgress
	if err := json.Unmarshal(raw, &loaded); err != nil {
		t.Fatal(err)
	}
	got := loaded.Workers[0].Messages
	if len(got) != 2 || got[0].Text != "make it about dogs" || got[0].Status != "applied" || got[0].Step != 3 || got[0].AppliedAt == "" ||
		got[1].Text != "and short" || got[1].Status != "dropped" {
		t.Fatalf("reloaded messages = %+v (%s)", got, raw)
	}
}

// A task's result keeps what the person sent its subagents, and the topic's history holds it for
// the next turns.
func TestChildMessagesReachTheTopicHistory(t *testing.T) {
	children := runtimecontrol.NewChildSteering()
	lease := children.OpenChild(context.Background(), agent.ChildSteerTarget{TaskID: "sub_1", Kind: agent.ChildKindSubagent, Worker: &agent.WorkerMetadata{ID: "worker-1", Name: "Curie"}})
	control := runtimecontrol.New()
	if err := control.Start(runtimecontrol.ActiveRun{Runtime: "console", ConversationKey: "k", TaskID: "task_1", Children: children}); err != nil {
		t.Fatal(err)
	}
	if got := control.SteerChild("console", "k", "worker-1", "make it about dogs"); !got.Queued {
		t.Fatalf("steer = %+v", got)
	}
	texts := lease.Source().Drain()
	lease.Source().(agent.SteerStepRecorder).SteerApplied(2, texts)
	lease.Finish()

	now := time.Now().UTC()
	result := map[string]any{"final": map[string]any{"output": "A haiku about dogs."}, chathistory.ChildMessagesResultKey: children.Messages()}
	// Stored and read back as JSON, as the store does.
	raw, _ := json.Marshal(result)
	var stored map[string]any
	_ = json.Unmarshal(raw, &stored)
	task := daemonruntime.TaskInfo{ID: "task_1", TopicID: "t", Task: "Write a haiku about cats", Status: daemonruntime.TaskDone, CreatedAt: now.Add(-time.Minute), FinishedAt: &now, Result: stored}
	history := chathistory.BuildTaskHistory([]daemonruntime.TaskInfo{task}, daemonruntime.TaskInfo{ID: "next", CreatedAt: now.Add(time.Minute)}, 10)
	if len(history) != 3 {
		t.Fatalf("history = %+v, want request, child message, reply", history)
	}
	if history[0].Text != "Write a haiku about cats" || history[2].Text != "A haiku about dogs." {
		t.Fatalf("history = %+v", history)
	}
	if history[1].Kind != chathistory.KindInboundUser || !strings.Contains(history[1].Text, "the subagent Curie (worker-1)") ||
		!strings.Contains(history[1].Text, "at its step 2") || !strings.HasSuffix(history[1].Text, "make it about dogs") {
		t.Fatalf("child message item = %+v", history[1])
	}
}
