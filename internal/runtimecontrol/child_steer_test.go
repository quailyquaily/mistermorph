package runtimecontrol

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/internal/llmstats"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// childSteerClient plays every agent of a run by depth: script answers the call-th request (from
// 1) an agent at depth makes.
type childSteerClient struct {
	script func(ctx context.Context, req llm.Request, depth, call int) llm.Result

	mu    sync.Mutex
	calls map[int]int
}

func (c *childSteerClient) Chat(ctx context.Context, req llm.Request) (llm.Result, error) {
	depth := agent.SubtaskDepthFromContext(ctx)
	c.mu.Lock()
	if c.calls == nil {
		c.calls = map[int]int{}
	}
	c.calls[depth]++
	call := c.calls[depth]
	c.mu.Unlock()
	return c.script(ctx, req, depth, call), nil
}

func childFinal(output string) llm.Result {
	raw, _ := json.Marshal(map[string]any{"type": "final", "output": output})
	return llm.Result{Text: string(raw)}
}

func childToolCall(id, name string, args map[string]any) llm.Result {
	return llm.Result{ToolCalls: []llm.ToolCall{{ID: id, Name: name, Arguments: args}}}
}

func lastToolContent(messages []llm.Message) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == "tool" {
			return messages[i].Content
		}
	}
	return ""
}

// userMessagesWith are the user messages of req holding text.
func userMessagesWith(req llm.Request, text string) []string {
	var out []string
	for _, message := range req.Messages {
		if message.Role == "user" && strings.Contains(message.Content, text) {
			out = append(out, message.Content)
		}
	}
	return out
}

type childProbeTool struct{}

func (childProbeTool) Name() string            { return "probe" }
func (childProbeTool) Description() string     { return "probe" }
func (childProbeTool) ParameterSchema() string { return `{"type":"object"}` }
func (childProbeTool) Execute(context.Context, map[string]any) (string, error) {
	return "probed", nil
}

// cliTool runs a function child, as coder runs a coding CLI; during runs while it does.
type cliTool struct {
	during func(ctx context.Context)
}

func (cliTool) Name() string            { return "cli" }
func (cliTool) Description() string     { return "cli" }
func (cliTool) ParameterSchema() string { return `{"type":"object"}` }
func (t cliTool) Execute(ctx context.Context, _ map[string]any) (string, error) {
	runner, ok := agent.SubtaskRunnerFromContext(ctx)
	if !ok {
		return "", nil
	}
	result, err := runner.RunSubtask(ctx, agent.SubtaskRequest{
		Task: "run the CLI",
		RunFunc: func(runCtx context.Context) (*agent.SubtaskResult, error) {
			t.during(runCtx)
			return &agent.SubtaskResult{Status: agent.SubtaskStatusDone, Output: "cli done"}, nil
		},
	})
	if err != nil {
		return "", err
	}
	raw, _ := json.Marshal(result)
	return string(raw), nil
}

type childSteerHarness struct {
	control  *RunControl
	children *ChildSteering
	ctx      context.Context

	mu     sync.Mutex
	events []agent.Event
}

func newChildSteerHarness(t *testing.T) *childSteerHarness {
	t.Helper()
	h := &childSteerHarness{control: New(), children: NewChildSteering()}
	if err := h.control.Start(ActiveRun{Runtime: "console", ConversationKey: "topic", TaskID: "task-1", Children: h.children}); err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	sink := agent.EventSinkFunc(func(_ context.Context, event agent.Event) {
		switch event.Kind {
		case agent.EventKindSteerQueued, agent.EventKindSteerApplied, EventKindSteerDropped:
			h.mu.Lock()
			h.events = append(h.events, event)
			h.mu.Unlock()
		}
	})
	ctx := llmstats.WithRunID(context.Background(), "task-1")
	h.ctx = agent.WithChildSteerHub(agent.WithEventSinkContext(ctx, sink), h.children)
	return h
}

func (h *childSteerHarness) steer(childID, text string) ChildSteerResult {
	return h.control.SteerChild("console", "topic", childID, text)
}

func (h *childSteerHarness) steerEvents() []agent.Event {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]agent.Event(nil), h.events...)
}

func newChildSteerEngine(t *testing.T, client llm.Client, extra ...tools.Tool) *agent.Engine {
	t.Helper()
	reg := tools.NewRegistry()
	for _, tool := range append([]tools.Tool{childProbeTool{}}, extra...) {
		if err := reg.Register(tool); err != nil {
			t.Fatalf("Register(%s) error = %v", tool.Name(), err)
		}
	}
	return agent.New(client, reg, agent.Config{MaxSteps: 6, DefaultModel: "test-model"}, agent.DefaultPromptSpec())
}

func TestSpawnedChildTakesSteeredMessageAtItsNextStep(t *testing.T) {
	h := newChildSteerHarness(t)
	var queued ChildSteerResult
	var seenAtFirstCall, seenAtSecondCall []string
	client := &childSteerClient{script: func(_ context.Context, req llm.Request, depth, call int) llm.Result {
		switch {
		case depth == 0 && call == 1:
			return childToolCall("spawn-1", "spawn", map[string]any{"task": "write a haiku about cats", "tools": []any{"probe"}})
		case depth == 0:
			return childFinal(lastToolContent(req.Messages))
		case call == 1:
			// The message arrives while the child's model call runs: it waits for the next step.
			queued = h.steer("worker-1", "make it about dogs")
			seenAtFirstCall = userMessagesWith(req, "make it about dogs")
			return childToolCall("probe-1", "probe", map[string]any{})
		default:
			seenAtSecondCall = userMessagesWith(req, "make it about dogs")
			return childFinal("a haiku about dogs")
		}
	}}
	final, _, err := newChildSteerEngine(t, client).Run(h.ctx, "root task", agent.RunOptions{SteerSource: NewSteerQueue(0)})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !queued.Queued || queued.ChildID != "worker-1" || !strings.HasPrefix(queued.ChildTaskID, "sub_") || queued.TaskID != "task-1" {
		t.Fatalf("steer result = %+v, want queued for worker-1 of task-1", queued)
	}
	if len(seenAtFirstCall) != 0 {
		t.Fatalf("message reached the model call already running: %q", seenAtFirstCall)
	}
	if len(seenAtSecondCall) != 1 || !strings.Contains(seenAtSecondCall[0], "[[ Message From The User ]]") ||
		!strings.Contains(seenAtSecondCall[0], "not the agent that gave you this task") {
		t.Fatalf("child's next request user messages = %q, want the message marked as from the user", seenAtSecondCall)
	}

	// The parent reads a result the person redirected, not a fault.
	output, _ := final.Output.(string)
	var result agent.SubtaskResult
	if err := json.Unmarshal([]byte(output), &result); err != nil {
		t.Fatalf("root output is not the child's envelope: %v (%q)", err, output)
	}
	if result.Status != agent.SubtaskStatusDone || len(result.UserMessages) != 1 || result.UserMessages[0] != "make it about dogs" || result.Note != agent.SubtaskRedirectedNote {
		t.Fatalf("child result = %+v, want done with the user's message and the redirect note", result)
	}

	// The record holds the message, applied at the child's second step.
	messages := h.children.Messages()
	if len(messages) != 1 || messages[0].Status != ChildMessageApplied || messages[0].Step != 2 || messages[0].ChildID != "worker-1" ||
		messages[0].ChildTaskID != queued.ChildTaskID || messages[0].ParentRunID != "task-1" || messages[0].AppliedAt == nil {
		t.Fatalf("messages = %+v, want one applied at step 2", messages)
	}
	events := h.steerEvents()
	if len(events) != 2 || events[0].Kind != agent.EventKindSteerQueued || events[1].Kind != agent.EventKindSteerApplied {
		t.Fatalf("steer events = %+v, want queued then applied", events)
	}
	for _, event := range events {
		if event.Worker == nil || event.Worker.ID != "worker-1" || event.RunID != queued.ChildTaskID || event.Text != "make it about dogs" {
			t.Fatalf("event %s = %+v, want it to name worker-1 and its run", event.Kind, event)
		}
	}
	if events[1].Step != 2 || events[1].Args["target"] != "child" {
		t.Fatalf("applied event = %+v, want step 2 for a child", events[1])
	}

	// Once the child has returned, a message for it is refused as finished, and nothing is lost.
	late := h.steer("worker-1", "and add a title")
	if late.Queued || late.Reason != SteerRejectedChildFinished || late.ChildID != "worker-1" {
		t.Fatalf("late steer = %+v, want child_finished", late)
	}
	if text := ChildSteerRejectedText(late); !strings.Contains(text, "finished") || !strings.Contains(text, "main agent") {
		t.Fatalf("finished text = %q", text)
	}
	if got := h.children.Messages(); len(got) != 1 {
		t.Fatalf("a refused message was recorded as sent: %+v", got)
	}
	if got := h.steer("worker-9", "hello"); got.Reason != SteerRejectedChildNotFound {
		t.Fatalf("unknown child = %+v, want child_not_found", got)
	}
	h.control.Finish("console", "topic", "task-1")
	if got := h.steer("worker-1", "hello"); got.Found || got.Reason != SteerRejectedNoRun {
		t.Fatalf("after the run = %+v, want no_active_run", got)
	}
}

func TestMessageQueuedAsChildAnswersIsStillTakenIn(t *testing.T) {
	h := newChildSteerHarness(t)
	var finalRequest []string
	client := &childSteerClient{script: func(_ context.Context, req llm.Request, depth, call int) llm.Result {
		switch {
		case depth == 0 && call == 1:
			return childToolCall("spawn-1", "spawn", map[string]any{"task": "summarize", "tools": []any{"probe"}})
		case depth == 0:
			return childFinal(lastToolContent(req.Messages))
		case call == 1:
			// Sent while the child writes what would have been its answer.
			if got := h.steer("worker-1", "keep it short"); !got.Queued {
				t.Errorf("steer = %+v, want queued", got)
			}
			return childFinal("a long summary")
		default:
			finalRequest = userMessagesWith(req, "keep it short")
			return childFinal("short")
		}
	}}
	final, _, err := newChildSteerEngine(t, client).Run(h.ctx, "root task", agent.RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if len(finalRequest) != 1 {
		t.Fatalf("the child answered without taking the message in")
	}
	var result agent.SubtaskResult
	_ = json.Unmarshal([]byte(final.Output.(string)), &result)
	if result.Output != "short" || len(result.UserMessages) != 1 {
		t.Fatalf("child result = %+v", result)
	}
	if messages := h.children.Messages(); len(messages) != 1 || messages[0].Status != ChildMessageApplied {
		t.Fatalf("messages = %+v", messages)
	}
}

func TestNestedChildrenAreAddressedByWorkerOrSubtaskID(t *testing.T) {
	h := newChildSteerHarness(t)
	var outerTaskID string
	var outerSaw, innerSaw []string
	var outerQueued, innerQueued ChildSteerResult
	client := &childSteerClient{script: func(ctx context.Context, req llm.Request, depth, call int) llm.Result {
		switch {
		case depth == 0 && call == 1:
			return childToolCall("spawn-1", "spawn", map[string]any{"task": "outer", "tools": []any{"probe", "spawn"}})
		case depth == 1 && call == 1:
			outerTaskID = llmstats.RunIDFromContext(ctx)
			return childToolCall("spawn-2", "spawn", map[string]any{"task": "inner", "tools": []any{"probe"}})
		case depth == 2 && call == 1:
			// Both run now: the inner child by its worker ID, the outer by its subtask ID.
			innerQueued = h.steer("worker-2", "inner: use metric units")
			outerQueued = h.steer(outerTaskID, "outer: answer in French")
			return childToolCall("probe-1", "probe", map[string]any{})
		case depth == 2:
			innerSaw = userMessagesWith(req, "inner: use metric units")
			return childFinal("inner done")
		case depth == 1:
			outerSaw = userMessagesWith(req, "outer: answer in French")
			return childFinal(lastToolContent(req.Messages))
		default:
			return childFinal(lastToolContent(req.Messages))
		}
	}}
	if _, _, err := newChildSteerEngine(t, client).Run(h.ctx, "root task", agent.RunOptions{}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if !innerQueued.Queued || innerQueued.ChildID != "worker-2" || innerQueued.ParentRunID != outerTaskID {
		t.Fatalf("inner steer = %+v, want worker-2 started by %s", innerQueued, outerTaskID)
	}
	if !outerQueued.Queued || outerQueued.ChildID != "worker-1" || outerQueued.ChildTaskID != outerTaskID {
		t.Fatalf("outer steer = %+v, want worker-1 (%s)", outerQueued, outerTaskID)
	}
	if len(innerSaw) != 1 || len(outerSaw) != 1 {
		t.Fatalf("inner saw %q, outer saw %q; want each its own message", innerSaw, outerSaw)
	}
	messages := h.children.Messages()
	if len(messages) != 2 || messages[0].Status != ChildMessageApplied || messages[1].Status != ChildMessageApplied {
		t.Fatalf("messages = %+v, want both applied", messages)
	}
}

func TestFunctionChildRefusesMessages(t *testing.T) {
	h := newChildSteerHarness(t)
	var refused ChildSteerResult
	cli := cliTool{during: func(runCtx context.Context) {
		refused = h.steer(agent.WorkerFromContext(runCtx).ID, "stop editing that file")
	}}
	client := &childSteerClient{script: func(_ context.Context, req llm.Request, depth, call int) llm.Result {
		if call == 1 {
			return childToolCall("cli-1", "cli", map[string]any{})
		}
		return childFinal(lastToolContent(req.Messages))
	}}
	if _, _, err := newChildSteerEngine(t, client, cli).Run(h.ctx, "root task", agent.RunOptions{}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if refused.Queued || refused.Reason != SteerRejectedChildUnsupported || refused.ChildID == "" {
		t.Fatalf("steer = %+v, want child_unsupported", refused)
	}
	if text := ChildSteerRejectedText(refused); !strings.Contains(text, "cannot take messages") {
		t.Fatalf("unsupported text = %q", text)
	}
	if got := h.children.Messages(); len(got) != 0 {
		t.Fatalf("a refused message was recorded: %+v", got)
	}
}

func TestChildReturningBeforeItsNextStepReportsTheMessageDropped(t *testing.T) {
	children := NewChildSteering()
	var events []agent.Event
	sink := agent.EventSinkFunc(func(_ context.Context, event agent.Event) { events = append(events, event) })
	lease := children.OpenChild(context.Background(), agent.ChildSteerTarget{
		TaskID: "sub_1", ParentRunID: "task-1", Kind: agent.ChildKindSubagent, Sink: sink,
		Worker: &agent.WorkerMetadata{ID: "worker-1", Name: "Curie"},
	})
	source := lease.Source()
	if source == nil {
		t.Fatal("an agent child got no source")
	}
	if got := children.steer("task-1", "worker-1", "first"); !got.Queued || got.ChildName != "Curie" || got.Pending != 1 {
		t.Fatalf("steer = %+v", got)
	}
	// The child's engine ends its run (closing its source) without another step.
	source.Close()
	if applied := lease.Finish(); len(applied) != 0 {
		t.Fatalf("Finish() = %q, want nothing applied", applied)
	}
	messages := children.Messages()
	if len(messages) != 1 || messages[0].Status != ChildMessageDropped || messages[0].Text != "first" {
		t.Fatalf("messages = %+v, want the message reported dropped", messages)
	}
	if len(events) != 2 || events[0].Kind != agent.EventKindSteerQueued || events[1].Kind != EventKindSteerDropped || events[1].Worker.ID != "worker-1" {
		t.Fatalf("events = %+v, want queued then dropped", events)
	}
	if got := children.steer("task-1", "worker-1", "second"); got.Reason != SteerRejectedChildFinished {
		t.Fatalf("after return = %+v, want child_finished", got)
	}
	if got := children.steer("task-1", "worker-1", "  "); got.Reason != SteerRejectedEmpty {
		t.Fatalf("empty = %+v, want empty", got)
	}
}

func TestSteerChildRefusedWhileStopping(t *testing.T) {
	h := newChildSteerHarness(t)
	h.children.OpenChild(context.Background(), agent.ChildSteerTarget{TaskID: "sub_1", Kind: agent.ChildKindSubagent, Worker: &agent.WorkerMetadata{ID: "worker-1"}})
	h.control.Stop("console", "topic", "/stop")
	if got := h.steer("worker-1", "hello"); got.Queued || got.Reason != SteerRejectedStopping {
		t.Fatalf("steer = %+v, want stopping", got)
	}
}

func TestStartLeaseCarriesChildSteering(t *testing.T) {
	control := New()
	lease, err := control.StartLease(context.Background(), 0, ActiveRun{Runtime: "console", ConversationKey: "topic", TaskID: "task-1"})
	if err != nil {
		t.Fatalf("StartLease() error = %v", err)
	}
	defer lease.Finish()
	if lease.Children == nil || agent.ChildSteerHubFromContext(lease.Context) != agent.ChildSteerHub(lease.Children) {
		t.Fatalf("lease children = %v, context hub = %v", lease.Children, agent.ChildSteerHubFromContext(lease.Context))
	}
}
