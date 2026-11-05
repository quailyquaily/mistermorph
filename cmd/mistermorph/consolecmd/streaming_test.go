package consolecmd

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/llmutil"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

func TestConsoleRetryNotificationsPublishAndRetainEachAttempt(t *testing.T) {
	hub := newConsoleStreamHub()
	frames, unsubscribe := hub.Subscribe("task-retry")
	defer unsubscribe()
	sink := newConsoleEventPreviewSink(hub, "task-retry", nil, nil)
	defer sink.Close()
	var latest *consoleActivityProgress
	sink.activityUpdated = func(progress *consoleActivityProgress) { latest = progress }
	for attempt := 1; attempt <= 2; attempt++ {
		event := llmutil.RetryEvent{Model: "test-model", Profile: "main", Attempt: attempt, MaxRetries: 5, Delay: time.Second, Reason: "HTTP 504 Gateway Timeout"}
		sink.HandleRetry(context.Background(), event)
		frame := <-frames
		if frame.Done || frame.Activity == nil || len(frame.Activity.History) != attempt {
			t.Fatalf("retry %d frame=%+v", attempt, frame)
		}
		current := frame.Activity.Current
		if current.Kind != "retry" || current.Name != "test-model" || current.Summary != event.StatusText() {
			t.Fatalf("retry activity=%+v", current)
		}
	}
	if latest == nil || len(latest.History) != 2 || latest.History[0].ID == latest.History[1].ID {
		t.Fatalf("retry attempts overwritten: %+v", latest)
	}
	replayed, stop := hub.Subscribe("task-retry")
	defer stop()
	if frame := <-replayed; frame.Activity == nil || len(frame.Activity.History) != 2 {
		t.Fatalf("reconnect lost retries: %+v", frame)
	}
	sink.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolStart, ActivityID: "tool:next", ToolName: "read_file", Status: "running"})
	if frame := <-frames; frame.Activity.Current.Kind != "tool" || len(frame.Activity.History) != 3 {
		t.Fatalf("new activity lost retry history: %+v", frame)
	}
}

type stubConsoleSemanticObserver struct {
	summary string
}

func TestConsoleStreamHubReplaysCompleteProgress(t *testing.T) {
	hub := newConsoleStreamHub()
	hub.PublishPreview("task", "working")
	hub.PublishPlan("task", &consolePlanProgress{Steps: []consolePlanStep{{Step: "inspect", Status: agent.PlanStatusInProgress}}})
	hub.PublishReasoning("task", "checking the code")
	hub.PublishInsights("task", []string{"The timeout is 0."})
	hub.PublishActivity("task", &consoleActivityProgress{Current: &consoleActivityEntry{ID: "coder", Kind: "tool", Name: "coder", Output: "Read source.go"}})
	hub.PublishStatus("task", "running")
	frames, unsubscribe := hub.Subscribe("task")
	defer unsubscribe()
	frame := <-frames
	if frame.Plan == nil || frame.Activity == nil || frame.Reasoning != "checking the code" || frame.Text != "working" || !frame.Preview || len(frame.Insights) != 1 {
		t.Fatalf("reconnect snapshot lost progress: %#v", frame)
	}
	hub.PublishFinal("task", "finished")
	frame = <-frames
	if !frame.Done || frame.Preview || frame.Text != "finished" || frame.Plan == nil || frame.Activity == nil || frame.Reasoning == "" || len(frame.Insights) != 1 {
		t.Fatalf("final snapshot lost progress or retained preview: %#v", frame)
	}
}

func (s stubConsoleSemanticObserver) Summarize(_ context.Context, _ consoleObserveRequest) (string, error) {
	return s.summary, nil
}

func TestConsoleStreamHubClearTextDropsTheShownReply(t *testing.T) {
	hub := newConsoleStreamHub()
	hub.PublishSnapshot("task", "I found a bug")
	hub.PublishClearText("task")
	hub.PublishInsights("task", []string{"I found a bug"})
	frames, unsubscribe := hub.Subscribe("task")
	defer unsubscribe()
	frame := <-frames
	if frame.Text != "" || len(frame.Insights) != 1 {
		t.Fatalf("frame after clear = %#v, want no reply text and the insight", frame)
	}
}

func TestConsoleStreamHubEvictsDoneFrameWithoutSubscribers(t *testing.T) {
	hub := newConsoleStreamHub()
	taskID := "task-no-subscriber"

	hub.PublishSnapshot(taskID, "partial output")
	if _, ok := hub.Latest(taskID); !ok {
		t.Fatal("latest snapshot missing before completion")
	}

	hub.PublishFinal(taskID, "final output")
	if _, ok := hub.Latest(taskID); ok {
		t.Fatal("latest entry retained after done frame without subscribers")
	}
}

func TestConsoleStreamHubEvictsDoneFrameOnLastUnsubscribe(t *testing.T) {
	hub := newConsoleStreamHub()
	taskID := "task-with-subscriber"

	_, unsubscribe := hub.Subscribe(taskID)
	hub.PublishFinal(taskID, "final output")

	latest, ok := hub.Latest(taskID)
	if !ok {
		t.Fatal("latest entry missing while subscriber is connected")
	}
	if !latest.Done {
		t.Fatalf("latest.Done = %v, want true", latest.Done)
	}

	unsubscribe()
	if _, ok := hub.Latest(taskID); ok {
		t.Fatal("latest entry retained after last subscriber unsubscribed")
	}
}

func TestConsoleReplySinkDefersSnapshotsUntilGuardedFinal(t *testing.T) {
	hub := newConsoleStreamHub()
	taskID := "task-guarded-stream"
	_, unsubscribe := hub.Subscribe(taskID)
	defer unsubscribe()

	outputGuard := guard.New(guard.Config{Enabled: true}, nil, nil)
	sink := newConsoleReplySink(hub, taskID, nil, outputGuard)
	if err := sink.Update(context.Background(), "password=unredacted"); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if _, ok := hub.Latest(taskID); ok {
		t.Fatal("unguarded stream snapshot was published")
	}
	if err := sink.Finalize(context.Background(), "password=[redacted]"); err != nil {
		t.Fatalf("Finalize() error = %v", err)
	}
	frame, ok := hub.Latest(taskID)
	if !ok {
		t.Fatal("guarded final frame was not published")
	}
	if !frame.Done || frame.Text != "password=[redacted]" {
		t.Fatalf("final frame = %#v", frame)
	}
}

func TestConsoleReasoningSinkAppendsModelCalls(t *testing.T) {
	hub := newConsoleStreamHub()
	taskID := "task-reasoning"
	sink := newConsoleReasoningSink(hub, taskID, nil)

	if err := sink.Handle(llm.StreamEvent{
		ReasoningDelta: &llm.ReasoningDelta{
			Index: 0,
			Type:  llm.ReasoningDeltaThinking,
			Delta: "inspect",
		},
	}); err != nil {
		t.Fatalf("Handle(first delta) error = %v", err)
	}
	if err := sink.Handle(llm.StreamEvent{
		ReasoningDelta: &llm.ReasoningDelta{
			Index: 0,
			Type:  llm.ReasoningDeltaThinking,
			Delta: " first",
		},
	}); err != nil {
		t.Fatalf("Handle(second delta) error = %v", err)
	}
	if err := sink.Handle(llm.StreamEvent{Done: true}); err != nil {
		t.Fatalf("Handle(done) error = %v", err)
	}

	frame, ok := hub.Latest(taskID)
	if !ok {
		t.Fatal("expected reasoning frame")
	}
	if frame.Reasoning != "inspect first" {
		t.Fatalf("frame.Reasoning = %q, want %q", frame.Reasoning, "inspect first")
	}
	if sink.Snapshot() != "inspect first" {
		t.Fatalf("Snapshot() = %q, want %q", sink.Snapshot(), "inspect first")
	}

	if err := sink.Handle(llm.StreamEvent{
		ReasoningDelta: &llm.ReasoningDelta{
			Index: 1,
			Type:  llm.ReasoningDeltaSummary,
			Delta: "retry",
		},
	}); err != nil {
		t.Fatalf("Handle(next call) error = %v", err)
	}
	frame, ok = hub.Latest(taskID)
	if !ok {
		t.Fatal("expected next reasoning frame")
	}
	if frame.Reasoning != "inspect first\n\nretry" {
		t.Fatalf("frame.Reasoning = %q, want reasoning from both model calls", frame.Reasoning)
	}
	if sink.Snapshot() != "inspect first\n\nretry" {
		t.Fatalf("Snapshot() = %q, want reasoning from both model calls", sink.Snapshot())
	}
}

func TestConsoleReasoningSinkSeparatesReasoningBlocks(t *testing.T) {
	hub := newConsoleStreamHub()
	sink := newConsoleReasoningSink(hub, "task-reasoning-blocks", nil)

	for _, delta := range []llm.ReasoningDelta{
		{Index: 0, Type: llm.ReasoningDeltaSummary, Delta: "first summary"},
		{Index: 1, Type: llm.ReasoningDeltaSummary, Delta: "second summary"},
	} {
		if err := sink.Handle(llm.StreamEvent{ReasoningDelta: &delta}); err != nil {
			t.Fatalf("Handle() error = %v", err)
		}
	}
	if err := sink.Handle(llm.StreamEvent{Done: true}); err != nil {
		t.Fatalf("Handle(done) error = %v", err)
	}

	if got := sink.Snapshot(); got != "first summary\n\nsecond summary" {
		t.Fatalf("Snapshot() = %q", got)
	}
}

func TestConsoleReasoningSinkUsesGuardRedaction(t *testing.T) {
	hub := newConsoleStreamHub()
	outputGuard := guard.New(guard.Config{
		Enabled: true,
		Redaction: guard.RedactionConfig{
			Enabled: true,
			Patterns: []guard.RegexPattern{
				{Name: "reasoning secret", Re: `secret-[0-9]+`},
			},
		},
	}, nil, nil)
	sink := newConsoleReasoningSink(hub, "task-guarded-reasoning", outputGuard)

	if err := sink.Handle(llm.StreamEvent{
		ReasoningDelta: &llm.ReasoningDelta{Delta: "inspect secret-1234"},
	}); err != nil {
		t.Fatalf("Handle() error = %v", err)
	}
	frame, ok := hub.Latest("task-guarded-reasoning")
	if !ok {
		t.Fatal("guarded reasoning was not published")
	}
	if frame.Reasoning != "inspect [redacted]" {
		t.Fatalf("frame.Reasoning = %q, want redacted reasoning", frame.Reasoning)
	}
	if got := sink.Snapshot(); got != "inspect [redacted]" {
		t.Fatalf("Snapshot() = %q, want redacted reasoning", got)
	}
}

func TestConsoleEventPreviewSinkPublishesBashTail(t *testing.T) {
	hub := newConsoleStreamHub()
	sink := newConsoleEventPreviewSink(hub, "task-preview", nil, nil)

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolStart,
		ToolName: "bash",
		Status:   "running",
	})
	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "bash",
		Stream:   "stdout",
		Text:     "alpha\n",
	})
	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "bash",
		Stream:   "stderr",
		Text:     "warn\n",
	})
	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolDone,
		ToolName: "bash",
		Status:   "done",
	})

	frame, ok := hub.Latest("task-preview")
	if !ok {
		t.Fatal("expected preview frame")
	}
	if !strings.Contains(frame.Text, "[bash] done") {
		t.Fatalf("frame.Text = %q, want bash done line", frame.Text)
	}
	if !strings.Contains(frame.Text, "stdout:\nalpha") {
		t.Fatalf("frame.Text = %q, want stdout tail", frame.Text)
	}
	if !strings.Contains(frame.Text, "stderr:\nwarn") {
		t.Fatalf("frame.Text = %q, want stderr tail", frame.Text)
	}
}

func TestConsoleEventPreviewSinkPublishesCoderActivityOutput(t *testing.T) {
	hub := newConsoleStreamHub()
	sink := newConsoleEventPreviewSink(hub, "task-coder", nil, nil)

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:       agent.EventKindToolStart,
		ActivityID: "tool:coder",
		ToolName:   "coder",
		Status:     "running",
	})
	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "coder",
		Stream:   "codex",
		Text:     "working",
		Status:   "running",
	})

	frame, ok := hub.Latest("task-coder")
	if !ok {
		t.Fatal("expected coder activity frame")
	}
	if frame.Activity == nil || frame.Activity.Current == nil {
		t.Fatalf("frame.Activity = %#v, want current activity", frame.Activity)
	}
	if frame.Activity.Current.Output != "working" {
		t.Fatalf("frame.Activity.Current.Output = %q, want working", frame.Activity.Current.Output)
	}
	if frame.Activity.Current.Stream != "codex" {
		t.Fatalf("frame.Activity.Current.Stream = %q, want codex", frame.Activity.Current.Stream)
	}
}

func TestConsoleEventPreviewSinkHidesRawToolOutputWhenGuardEnabled(t *testing.T) {
	hub := newConsoleStreamHub()
	outputGuard := guard.New(guard.Config{Enabled: true}, nil, nil)
	sink := newConsoleEventPreviewSink(hub, "task-guarded-tool", nil, outputGuard)

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:       agent.EventKindToolStart,
		ActivityID: "tool:coder",
		ToolName:   "coder",
		Status:     "running",
	})
	sink.HandleEvent(context.Background(), agent.Event{
		Kind:       agent.EventKindToolOutput,
		ActivityID: "tool:coder",
		ToolName:   "coder",
		Stream:     "codex",
		Text:       "password=unredacted",
		Status:     "running",
	})
	sink.HandleEvent(context.Background(), agent.Event{
		Kind:       agent.EventKindToolDone,
		ActivityID: "tool:coder",
		ToolName:   "coder",
		Status:     "failed",
		Error:      "password=unredacted",
	})

	frame, ok := hub.Latest("task-guarded-tool")
	if !ok {
		t.Fatal("expected status-only preview frame")
	}
	if strings.Contains(frame.Text, "unredacted") {
		t.Fatalf("preview leaked raw tool output: %q", frame.Text)
	}
	if frame.Activity != nil && frame.Activity.Current != nil && strings.Contains(frame.Activity.Current.Output, "unredacted") {
		t.Fatalf("activity leaked raw tool output: %#v", frame.Activity.Current)
	}
}

func TestConsoleEventPreviewSinkKeepsCoderStatusWhenGuardEnabled(t *testing.T) {
	for _, backend := range []string{"claude", "codex"} {
		t.Run(backend, func(t *testing.T) {
			hub := newConsoleStreamHub()
			sink := newConsoleEventPreviewSink(hub, "task", nil, guard.New(guard.Config{Enabled: true}, nil, nil))
			defer sink.Close()
			summary := "[" + backend + "] tool completed"
			sink.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolStart, ActivityID: "coder", ToolName: "coder", Status: "running"})
			sink.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolOutput, ToolName: "coder", Stream: backend, Summary: summary, Text: "private file contents"})
			frame, _ := hub.Latest("task")
			if frame.Activity == nil || frame.Activity.Current == nil || !strings.Contains(frame.Activity.Current.Output, summary) || strings.Contains(frame.Activity.Current.Output, "private") {
				t.Fatalf("guarded progress = %#v", frame.Activity)
			}
		})
	}
}

func TestConsoleEventPreviewSinkShowsAgentLinkMessages(t *testing.T) {
	redacting := guard.New(guard.Config{Enabled: true, Redaction: guard.RedactionConfig{Enabled: true,
		Patterns: []guard.RegexPattern{{Name: "token", Re: `tok-[a-z0-9]+`}}}}, nil, nil)
	cases := []struct {
		name  string
		guard *guard.Guard
		want  []string
	}{
		{name: "guard off", want: []string{"sent:Isla:how are you? tok-abc123", "reply:Isla:fine, thanks"}},
		{name: "guard on", guard: redacting, want: []string{"sent:Isla:how are you? [redacted]", "reply:Isla:fine, thanks"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			hub := newConsoleStreamHub()
			sink := newConsoleEventPreviewSink(hub, "task", nil, tc.guard)
			defer sink.Close()
			sink.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolStart, ActivityID: "send", ToolName: "agent_send", Status: "running"})
			for _, event := range []agent.Event{
				{Stream: builtin.AgentLinkStreamSent, Text: "how are you? tok-abc123"},
				{Stream: builtin.AgentLinkStreamReply, Text: "fine, thanks"},
			} {
				event.Kind, event.ActivityID, event.ToolName, event.Summary, event.Status = agent.EventKindToolOutput, "send", "agent_send", "Isla", "running"
				sink.HandleEvent(context.Background(), event)
			}
			frame, _ := hub.Latest("task")
			if frame.Activity == nil || len(frame.Activity.History) != 1 {
				t.Fatalf("activity = %#v", frame.Activity)
			}
			var got []string
			for _, m := range frame.Activity.History[0].Messages {
				got = append(got, m.Direction+":"+m.Peer+":"+m.Text)
			}
			if strings.Join(got, "|") != strings.Join(tc.want, "|") {
				t.Fatalf("messages = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestConsoleStreamHubPublishesPlanFrame(t *testing.T) {
	hub := newConsoleStreamHub()
	taskID := "task-plan"

	hub.PublishPlan(taskID, &consolePlanProgress{
		Steps: []consolePlanStep{
			{Step: "scan repo", Status: agent.PlanStatusCompleted},
			{Step: "patch bug", Status: agent.PlanStatusInProgress},
		},
	})

	frame, ok := hub.Latest(taskID)
	if !ok {
		t.Fatal("expected plan frame")
	}
	if frame.Status != "running" {
		t.Fatalf("frame.Status = %q, want %q", frame.Status, "running")
	}
	if frame.Plan == nil {
		t.Fatal("frame.Plan = nil")
	}
	if len(frame.Plan.Steps) != 2 {
		t.Fatalf("len(frame.Plan.Steps) = %d, want 2", len(frame.Plan.Steps))
	}
	if frame.Plan.Steps[1].Status != agent.PlanStatusInProgress {
		t.Fatalf("frame.Plan.Steps[1].Status = %q, want %q", frame.Plan.Steps[1].Status, agent.PlanStatusInProgress)
	}
}

func TestConsoleStreamHubPublishesActivityFrame(t *testing.T) {
	hub := newConsoleStreamHub()
	taskID := "task-activity"

	hub.PublishActivity(taskID, &consoleActivityProgress{
		Current: &consoleActivityEntry{
			ID:     "tool:1",
			Kind:   "tool",
			Name:   "web_search",
			Status: "running",
			Args: map[string]any{
				"q": "alpha",
			},
		},
		History: []consoleActivityEntry{
			{
				ID:     "tool:1",
				Kind:   "tool",
				Name:   "web_search",
				Status: "running",
			},
		},
	})

	frame, ok := hub.Latest(taskID)
	if !ok {
		t.Fatal("expected activity frame")
	}
	if frame.Activity == nil || frame.Activity.Current == nil {
		t.Fatalf("frame.Activity = %#v, want current activity", frame.Activity)
	}
	if frame.Activity.Current.Name != "web_search" {
		t.Fatalf("frame.Activity.Current.Name = %q, want web_search", frame.Activity.Current.Name)
	}
	if frame.Activity.Current.Args["q"] != "alpha" {
		t.Fatalf("frame.Activity.Current.Args[q] = %#v, want alpha", frame.Activity.Current.Args["q"])
	}
}

func TestConsoleStreamHubPublishesReasoningFrame(t *testing.T) {
	hub := newConsoleStreamHub()
	taskID := "task-reasoning-frame"

	hub.PublishReasoning(taskID, "inspect first")

	frame, ok := hub.Latest(taskID)
	if !ok {
		t.Fatal("expected reasoning frame")
	}
	if frame.Status != "running" {
		t.Fatalf("frame.Status = %q, want %q", frame.Status, "running")
	}
	if frame.Reasoning != "inspect first" {
		t.Fatalf("frame.Reasoning = %q, want %q", frame.Reasoning, "inspect first")
	}
}

func TestConsoleStreamHubPublishesPreviewFrame(t *testing.T) {
	hub := newConsoleStreamHub()
	taskID := "task-preview"

	hub.PublishPreview(taskID, "[web_search] done")

	frame, ok := hub.Latest(taskID)
	if !ok {
		t.Fatal("expected preview frame")
	}
	if !frame.Preview {
		t.Fatal("frame.Preview = false, want true")
	}
	if frame.Text != "[web_search] done" {
		t.Fatalf("frame.Text = %q, want %q", frame.Text, "[web_search] done")
	}
}

func TestConsoleEventPreviewSinkLongShellThrottlesOutput(t *testing.T) {
	hub := newConsoleStreamHub()
	sink := newConsoleEventPreviewSink(hub, "task-throttle", nil, nil)

	now := time.Unix(1000, 0)
	sink.now = func() time.Time { return now }

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolStart,
		ToolName: "bash",
		Status:   "running",
	})
	startFrame, ok := hub.Latest("task-throttle")
	if !ok {
		t.Fatal("expected initial throttle frame")
	}
	startSeq := startFrame.Seq

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "bash",
		Profile:  string(agent.ObserveProfileLongShell),
		Stream:   "stdout",
		Text:     "a",
	})
	firstOutputFrame, ok := hub.Latest("task-throttle")
	if !ok {
		t.Fatal("expected first throttle output frame")
	}
	firstOutputSeq := firstOutputFrame.Seq
	if firstOutputSeq <= startSeq {
		t.Fatalf("first output should publish immediately, startSeq=%d firstOutputSeq=%d", startSeq, firstOutputSeq)
	}

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "bash",
		Profile:  string(agent.ObserveProfileLongShell),
		Stream:   "stdout",
		Text:     "b",
	})
	currentFrame, ok := hub.Latest("task-throttle")
	if !ok {
		t.Fatal("expected throttle frame after small output")
	}
	if currentFrame.Seq != firstOutputSeq {
		t.Fatalf("small incremental output should not publish immediately")
	}

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "bash",
		Profile:  string(agent.ObserveProfileLongShell),
		Stream:   "stdout",
		Text:     strings.Repeat("x", 300),
	})
	currentFrame, ok = hub.Latest("task-throttle")
	if !ok {
		t.Fatal("expected throttle frame after large output")
	}
	if currentFrame.Seq == firstOutputSeq {
		t.Fatalf("large incremental output should trigger publish")
	}
}

func TestConsoleEventPreviewSinkWebExtractSuppressesRawOutput(t *testing.T) {
	hub := newConsoleStreamHub()
	sink := newConsoleEventPreviewSink(hub, "task-web", nil, nil)

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:    agent.EventKindSubtaskStart,
		TaskID:  "sub_web",
		Mode:    "agent",
		Profile: string(agent.ObserveProfileWebExtract),
		Status:  "running",
	})
	startFrame, ok := hub.Latest("task-web")
	if !ok {
		t.Fatal("expected web preview frame")
	}
	startSeq := startFrame.Seq

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "url_fetch",
		Stream:   "stdout",
		Text:     "<html>noise</html>",
	})
	currentFrame, ok := hub.Latest("task-web")
	if !ok {
		t.Fatal("expected web preview frame after suppressed output")
	}
	if currentFrame.Seq != startSeq {
		t.Fatalf("web_extract raw output should stay suppressed before terminal event")
	}
}

func TestConsoleEventPreviewSinkWebExtractSchedulesObserverSummary(t *testing.T) {
	hub := newConsoleStreamHub()
	sink := newConsoleEventPreviewSink(hub, "task-observe", nil, nil)
	sink.observer = stubConsoleSemanticObserver{summary: "Found candidate article list and narrowed the target."}
	defer sink.Close()

	sink.HandleEvent(context.Background(), agent.Event{
		Kind:    agent.EventKindSubtaskStart,
		TaskID:  "sub_web",
		Mode:    "agent",
		Profile: string(agent.ObserveProfileWebExtract),
		Status:  "running",
	})
	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolOutput,
		ToolName: "url_fetch",
		Stream:   "stdout",
		Text:     "<html>noise</html>",
	})
	sink.HandleEvent(context.Background(), agent.Event{
		Kind:     agent.EventKindToolDone,
		ToolName: "url_fetch",
		Status:   "done",
	})

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		frame, ok := hub.Latest("task-observe")
		if ok && strings.Contains(frame.Text, "summary:\nFound candidate article list") {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	frame, ok := hub.Latest("task-observe")
	if !ok {
		t.Fatal("expected observer preview frame")
	}
	t.Fatalf("observer summary did not appear, latest=%s", fmt.Sprintf("%#v", frame))
}

// guardedCoderFrames feeds events to a sink and returns, as JSON, every frame the task had
// after each of them: all that a Console could have shown.
func guardedCoderFrames(t *testing.T, g *guard.Guard, events ...agent.Event) []string {
	t.Helper()
	hub := newConsoleStreamHub()
	sink := newConsoleEventPreviewSink(hub, "task", nil, g)
	defer sink.Close()
	sink.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolStart, ActivityID: "coder", ToolName: "coder", Status: "running"})
	var frames []string
	for _, event := range events {
		event.ActivityID, event.ToolName, event.Status = "coder", "coder", "running"
		if event.Stream == "" {
			event.Stream = "codex"
		}
		sink.HandleEvent(context.Background(), event)
		frame, _ := hub.Latest("task")
		raw, err := json.Marshal(frame)
		if err != nil {
			t.Fatal(err)
		}
		frames = append(frames, string(raw))
	}
	return frames
}

// consoleCoderOutput is the coder's output in the last frame.
func consoleCoderOutput(t *testing.T, frames []string) string {
	t.Helper()
	var frame consoleStreamFrame
	if err := json.Unmarshal([]byte(frames[len(frames)-1]), &frame); err != nil {
		t.Fatal(err)
	}
	if frame.Activity == nil || frame.Activity.Current == nil {
		return ""
	}
	return frame.Activity.Current.Output
}

// assertNoPieceShown fails when any frame holds eight characters in a row of secret.
func assertNoPieceShown(t *testing.T, frames []string, secret string) {
	t.Helper()
	for i := 0; i+8 <= len(secret); i++ {
		piece := secret[i : i+8]
		for n, frame := range frames {
			if strings.Contains(frame, piece) {
				t.Fatalf("frame %d shows %q of the secret: %s", n, piece, frame)
			}
		}
	}
}

func outputPiece(text string) agent.Event {
	return agent.Event{Kind: agent.EventKindToolOutput, Text: text}
}

func outputUnit(label, text string) agent.Event {
	return agent.Event{Kind: agent.EventKindToolOutputUnit, Summary: label, Text: text}
}

// With Guard on, a coder's output is shown from its complete units, each redacted as a whole.
// The live pieces, which may split a secret anywhere, are never shown.
func TestConsoleEventPreviewSinkShowsRedactedCoderUnitsWhenGuardEnabled(t *testing.T) {
	on := guard.New(guard.Config{Enabled: true, Redaction: guard.RedactionConfig{Enabled: true,
		Patterns: []guard.RegexPattern{{Name: "block", Re: `(?s)<secret>.*?</secret>`}}}}, nil, nil)
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
	for _, tc := range []struct {
		name   string
		text   string // one complete piece of output
		secret string
		want   string // what the Console shows for it
	}{
		{"sensitive key and value", "token=abcdefghijklmnopqrstuvwx\nok\n", "abcdefghijklmnopqrstuvwx", "token=[redacted]\nok\n"},
		{"value on the next line", "api_key=\nabcdefghijklmnopqrstuvwx\n", "abcdefghijklmnopqrstuvwx", "api_key=\n[redacted]\n"},
		{"bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwx\n", "abcdefghijklmnopqrstuvwx", "Authorization: Bearer [redacted]\n"},
		{"JWT", "jwt " + jwt + " end\n", jwt, "jwt [redacted_jwt] end\n"},
		{"MISTER_MORPH value over two lines", "MISTER_MORPH_API_KEY=\"first line\nsecondSECRET123456\" rest\n", "secondSECRET123456", "[redacted_env]=[redacted] rest\n"},
		{"private key block", "-----BEGIN RSA PRIVATE KEY-----\nSENSITIVEPAYLOAD123456\n-----END RSA PRIVATE KEY-----\n", "SENSITIVEPAYLOAD123456", "-----BEGIN PRIVATE KEY-----\n[redacted]\n-----END PRIVATE KEY-----\n"},
		{"private key block without END", "key:\n-----BEGIN RSA PRIVATE KEY-----\nSENSITIVEPAYLOAD123456", "SENSITIVEPAYLOAD123456", "key:\n[redacted private key]\n"},
		{"private key block without BEGIN", "SENSITIVEPAYLOAD123456\n-----END RSA PRIVATE KEY-----\nok\n", "SENSITIVEPAYLOAD123456", "[redacted private key]\nok\n"},
		{"custom pattern over lines", "a <secret>\nSENSITIVEPAYLOAD123456\n</secret> z\n", "SENSITIVEPAYLOAD123456", "a [redacted] z\n"},
		{"secret past the preview length", strings.Repeat("safe\n", 300) + "token=abcdefghijklmnopqrstuvwx\n", "abcdefghijklmnopqrstuvwx", ""},
		{"secret in a very long line", strings.Repeat("x", 70_000) + " " + strings.Repeat("y", 70_000) + " token=abcdefghijklmnopqrstuvwx\ntail\n", "abcdefghijklmnopqrstuvwx", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// The output arrives live cut at every position in turn, then whole as a unit.
			for cut := 0; cut <= len(tc.text); cut += 1 + len(tc.text)/97 {
				frames := guardedCoderFrames(t, on,
					agent.Event{Kind: agent.EventKindToolOutput, Summary: "[codex] command_execution in_progress (item_1)", Text: "[codex] command_execution in_progress (item_1) $ cat x\n" + tc.text[:cut]},
					outputPiece(tc.text[cut:]),
					outputUnit("", tc.text),
				)
				assertNoPieceShown(t, frames, tc.secret)
				got := consoleCoderOutput(t, frames)
				if !strings.HasPrefix(got, "[codex] command_execution in_progress (item_1)\n") && tc.want != "" {
					t.Fatalf("cut %d: status line missing: %q", cut, got)
				}
				if tc.want != "" && !strings.HasSuffix(got, "\n"+tc.want) {
					t.Fatalf("cut %d: output = %q, want it to end with %q", cut, got, tc.want)
				}
				if tc.want == "" && !strings.Contains(got, "[redacted]") {
					t.Fatalf("cut %d: the redacted value is not in the tail: %.200q", cut, got)
				}
			}
		})
	}
}

func TestConsoleEventPreviewSinkCoderUnitLabelsAndOrder(t *testing.T) {
	on := guard.New(guard.Config{Enabled: true}, nil, nil)
	frames := guardedCoderFrames(t, on,
		agent.Event{Kind: agent.EventKindToolOutput, Summary: "\n[claude] Bash (toolu_1)\n", Text: "\n[claude] Bash (toolu_1) {\"command\":\"x\"}\n"},
		outputUnit("", "command: export API_KEY=\nabcdefghijklmnopqrstuvwx"),
		outputUnit("[codex] stderr", "password=abcdefghijklmnop\nwarning: slow\n"),
		outputUnit("[codex] stderr not shown: it was too large to check as a whole", ""),
		outputUnit("", " \n"),
		outputUnit("token=abcdefghijklmnopqrstuvwx", "x\n"),
	)
	assertNoPieceShown(t, frames, "abcdefghijklmnopqrstuvwx")
	assertNoPieceShown(t, frames, "abcdefghijklmnop")
	want := "[claude] Bash (toolu_1)\n" +
		"command: export API_KEY=\n[redacted]\n" +
		"[codex] stderr\npassword=[redacted]\nwarning: slow\n" +
		"[codex] stderr not shown: it was too large to check as a whole\n" +
		"token=[redacted]\nx\n"
	if got := consoleCoderOutput(t, frames); strings.TrimLeft(got, "\n") != want {
		t.Fatalf("output = %q,\nwant %q", got, want)
	}
}

// Without Guard the Console shows the live pieces as it always did, and a unit, which repeats
// them, changes nothing.
func TestConsoleEventPreviewSinkIgnoresCoderUnitsWhenGuardDisabled(t *testing.T) {
	live := []agent.Event{
		{Kind: agent.EventKindToolOutput, Summary: "[codex] command_execution completed (item_1) exit=0", Text: "[codex] command_execution completed (item_1) exit=0 $ cat x\ntoken=abcdefgh"},
		outputPiece("ijklmnopqrstuvwx\n"),
	}
	withUnits := []agent.Event{live[0], outputUnit("", "$ cat x"), live[1], outputUnit("[codex] stderr", "token=abcdefghijklmnopqrstuvwx\n")}
	for name, g := range map[string]*guard.Guard{"no guard": nil, "guard disabled": guard.New(guard.Config{}, nil, nil)} {
		plain := guardedCoderFrames(t, g, live...)
		got := guardedCoderFrames(t, g, withUnits...)
		if a, b := consoleCoderOutput(t, plain), consoleCoderOutput(t, got); a != b || !strings.Contains(b, "token=abcdefghijklmnopqrstuvwx") || strings.Contains(b, "stderr") {
			t.Fatalf("%s: output with units = %q, without = %q", name, b, a)
		}
		// A unit publishes no frame of its own.
		if got[1] != got[0] || got[3] != got[2] {
			t.Fatalf("%s: a unit changed the frame", name)
		}
	}
}
