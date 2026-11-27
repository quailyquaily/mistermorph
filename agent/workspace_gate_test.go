package agent

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
)

// wsSwitchTool stands in for workspace_use: it moves the run's switch.
type wsSwitchTool struct{}

func (wsSwitchTool) Name() string            { return "workspace_use" }
func (wsSwitchTool) Description() string     { return "switch" }
func (wsSwitchTool) ParameterSchema() string { return "{}" }
func (wsSwitchTool) Execute(ctx context.Context, params map[string]any) (string, error) {
	sw, ok := pathroots.WorkspaceSwitchFromContext(ctx)
	if !ok {
		return "", nil
	}
	path, _ := params["path"].(string)
	sw.Use(path)
	return "switched", nil
}

// wsRecordingTool records the workspace each call ran in.
type wsRecordingTool struct {
	name string
	mu   sync.Mutex
	dirs []string
}

func (t *wsRecordingTool) Name() string            { return t.name }
func (t *wsRecordingTool) Description() string     { return t.name }
func (t *wsRecordingTool) ParameterSchema() string { return "{}" }
func (t *wsRecordingTool) Execute(ctx context.Context, _ map[string]any) (string, error) {
	dir, _ := pathroots.WorkspaceDirFromContext(ctx)
	t.mu.Lock()
	t.dirs = append(t.dirs, dir)
	t.mu.Unlock()
	return "ok", nil
}

func (t *wsRecordingTool) calls() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.dirs...)
}

func call(id, name string, args map[string]any) llm.ToolCall {
	if args == nil {
		args = map[string]any{}
	}
	return llm.ToolCall{ID: id, Name: name, Arguments: args}
}

func wsRegistry() (*tools.Registry, *wsRecordingTool, *wsRecordingTool, *wsRecordingTool) {
	reader := &wsRecordingTool{name: "read_file"}
	writer := &wsRecordingTool{name: "write_file"}
	shell := &wsRecordingTool{name: "bash"}
	reg := tools.NewRegistry()
	reg.Register(wsSwitchTool{})
	reg.Register(reader)
	reg.Register(writer)
	reg.Register(shell)
	return reg, reader, writer, shell
}

// switchedCtx is a run's context as the Console gives an owner chat run: a switch started in the
// topic's workspace.
func switchedCtx() context.Context {
	return pathroots.WithWorkspaceSwitch(context.Background(), pathroots.NewWorkspaceSwitch("/ws/topic"))
}

func TestWorkspaceSwitchAsksOnceBeforeTheFirstWrite(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	reg, reader, writer, shell := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("w0", "write_file", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("r1", "read_file", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("b1", "bash", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w2", "write_file", nil)}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 10}, DefaultPromptSpec(), WithGuard(g))

	pending, _, err := engine.Run(switchedCtx(), "work elsewhere", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	// Writing in the topic's own workspace asks nothing; reading in the other one asks nothing.
	if got := writer.calls(); len(got) != 1 || got[0] != "/ws/topic" {
		t.Fatalf("writes before approval = %v", got)
	}
	if got := reader.calls(); len(got) != 1 || got[0] != "/ws/other" {
		t.Fatalf("reads = %v, want one in the switched workspace", got)
	}
	approvalID := pendingApprovalID(t, pending)
	rec, ok, err := store.Get(context.Background(), approvalID)
	if err != nil || !ok || rec.ToolName != "write_file" || !strings.Contains(strings.Join(rec.Reasons, " "), guard.WorkspaceSwitchReason+": /ws/other") {
		t.Fatalf("approval = %+v, %v, %v", rec, ok, err)
	}
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatalf("ResolveApproval() error = %v", err)
	}
	// The Console resumes with a fresh context: a new switch in the topic's workspace. The run goes
	// on in the workspace it switched to, and asks nothing more there.
	final, _, err := engine.Resume(switchedCtx(), approvalID)
	if err != nil {
		t.Fatalf("Resume() error = %v", err)
	}
	if final == nil || final.Output != "done" {
		t.Fatalf("final = %#v", final)
	}
	if got := writer.calls(); len(got) != 3 || got[1] != "/ws/other" || got[2] != "/ws/other" {
		t.Fatalf("writes = %v", got)
	}
	if got := shell.calls(); len(got) != 1 || got[0] != "/ws/other" {
		t.Fatalf("shell = %v", got)
	}
}

func TestWorkspaceSwitchDeniedWriteDoesNotRun(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	reg, _, writer, _ := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil)}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g))
	pending, _, err := engine.Run(switchedCtx(), "work elsewhere", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	approvalID := pendingApprovalID(t, pending)
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalDenied, "tester", ""); err != nil {
		t.Fatalf("ResolveApproval() error = %v", err)
	}
	final, _, err := engine.Resume(switchedCtx(), approvalID)
	if err != nil {
		t.Fatalf("Resume() error = %v", err)
	}
	if _, stillPending := final.Output.(PendingOutput); !stillPending {
		t.Fatalf("denied resume final = %#v", final)
	}
	if got := writer.calls(); len(got) != 0 {
		t.Fatalf("denied write ran: %v", got)
	}
}

func TestWorkspaceSwitchWithoutApprovalsDeniesWrites(t *testing.T) {
	reg, _, writer, shell := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil), call("b1", "bash", nil)}},
		finalResponse("could not"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec())
	final, _, err := engine.Run(switchedCtx(), "work elsewhere", RunOptions{})
	if err != nil || final == nil || final.Output != "could not" {
		t.Fatalf("Run() = %#v, %v", final, err)
	}
	if len(writer.calls()) != 0 || len(shell.calls()) != 0 {
		t.Fatalf("ran without any approval store: writes %v, shell %v", writer.calls(), shell.calls())
	}
}

// A write in the same batch as the switch was checked before the switch: it must not run there.
func TestWriteBatchedAfterTheSwitchDoesNotRun(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	reg, _, writer, _ := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{
			call("s1", "workspace_use", map[string]any{"path": "/ws/other"}),
			call("w1", "write_file", nil),
		}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g))
	final, _, err := engine.Run(switchedCtx(), "work elsewhere", RunOptions{})
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Run() = %#v, %v", final, err)
	}
	if got := writer.calls(); len(got) != 0 {
		t.Fatalf("batched write ran unapproved: %v", got)
	}
	var observation string
	for _, msg := range client.allCalls()[1].Messages {
		if msg.Role == "tool" && msg.ToolCallID == "w1" {
			observation = msg.Content
		}
	}
	if !strings.Contains(observation, "need the user's approval") {
		t.Fatalf("write observation = %q", observation)
	}
}

// Codemode scripts cannot write in a switched workspace before approval.
func TestCodemodeCheckRejectsUnapprovedWorkspaceWrite(t *testing.T) {
	ctx := switchedCtx()
	sw, _ := pathroots.WorkspaceSwitchFromContext(ctx)
	sw.Use("/ws/other")
	e := New(nil, tools.NewRegistry(), Config{}, DefaultPromptSpec(), WithGuard(approvalsOnlyGuard(newMemoryApprovalStore())))
	st := &engineLoopState{runID: "r"}
	_, denied, approval, err := e.guardDecide(ctx, st, 1, &ToolCall{Name: "write_file"}, "")
	if err != nil || denied || approval == nil {
		t.Fatalf("decide = %v, %v, %v", denied, approval, err)
	}
	if _, _, approval, _ := e.guardDecide(ctx, st, 1, &ToolCall{Name: "read_file"}, ""); approval != nil {
		t.Fatal("reading asked for approval")
	}
}

func TestSubtaskWorksInAFixedWorkspace(t *testing.T) {
	ctx := switchedCtx()
	sw, _ := pathroots.WorkspaceSwitchFromContext(ctx)
	sw.Use("/ws/other")
	_, runCtx, _ := PrepareSubtaskContext(ctx, nil)
	if _, ok := pathroots.WorkspaceSwitchFromContext(runCtx); ok {
		t.Fatal("a subtask got the parent's workspace switch")
	}
	if dir, _ := pathroots.WorkspaceDirFromContext(runCtx); dir != "/ws/other" {
		t.Fatalf("subtask workspace = %q", dir)
	}
	sw.Use("/ws/topic")
	if dir, _ := pathroots.WorkspaceDirFromContext(runCtx); dir != "/ws/other" {
		t.Fatalf("subtask followed a later switch: %q", dir)
	}
}

type subtaskExcludedTool struct{ countingTool }

func (subtaskExcludedTool) SubtaskExcluded() bool { return true }

func TestSubtaskExcludedToolsAreNotHandedToSubtasks(t *testing.T) {
	reg := tools.NewRegistry()
	reg.Register(&subtaskExcludedTool{countingTool{name: "topic_read"}})
	reg.Register(&countingTool{name: "read_file"})
	e := New(nil, reg, Config{}, DefaultPromptSpec())
	if _, ok := e.lookupSubtaskTool("topic_read"); ok {
		t.Fatal("topic_read reached a subtask")
	}
	if _, ok := e.lookupSubtaskTool("read_file"); !ok {
		t.Fatal("read_file did not reach a subtask")
	}
}

// threadCtx is the context of a work thread's run that Solo started: a switch started in the
// workspace Solo chose for the thread, whatever Solo's own workspace is.
func threadCtx() context.Context {
	return pathroots.WithWorkspaceSwitch(context.Background(), pathroots.NewWorkspaceSwitch("/ws/thread"))
}

func (s *memoryApprovalStore) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.records)
}

// A work thread Solo started runs in the workspace Solo chose for it as its own: none of the
// tools a switched workspace asks for asks there, and no approval is recorded (so none expires).
func TestDispatchedWorkspaceNeedsNoWorkspaceApproval(t *testing.T) {
	store := newMemoryApprovalStore()
	e := New(nil, tools.NewRegistry(), Config{}, DefaultPromptSpec(), WithGuard(approvalsOnlyGuard(store)))
	for name := range workspaceGatedTools {
		t.Run(name, func(t *testing.T) {
			ctx := threadCtx()
			if dir, pending := workspaceApprovalPending(ctx, name); pending {
				t.Fatalf("%s is pending approval in the thread's own workspace %s", name, dir)
			}
			st := &engineLoopState{runID: "r"}
			observation, denied, approval, err := e.guardDecide(ctx, st, 1, &ToolCall{Name: name}, "")
			if err != nil || denied || approval != nil || observation != "" {
				t.Fatalf("decide in the thread's workspace = %q, %v, %v, %v", observation, denied, approval, err)
			}
			// The same tool after the thread switches to another workspace still asks.
			sw, _ := pathroots.WorkspaceSwitchFromContext(ctx)
			sw.Use("/ws/unrelated")
			_, denied, approval, err = e.guardDecide(ctx, st, 2, &ToolCall{Name: name}, "")
			if err != nil || denied || approval == nil || !approval.Forced ||
				!strings.Contains(strings.Join(approval.Reasons, " "), guard.WorkspaceSwitchReason+": /ws/unrelated") {
				t.Fatalf("decide after a switch = %v, %+v, %v", denied, approval, err)
			}
			if dir, pending := workspaceApprovalPending(ctx, name); !pending || dir != "/ws/unrelated" {
				t.Fatalf("after a switch: pending=%v dir=%q", pending, dir)
			}
		})
	}
	if n := store.count(); n != 0 {
		t.Fatalf("approvals recorded = %d, want none", n)
	}
}

// The whole of a thread's run: it writes and runs commands in its own workspace with no approval,
// a later workspace_use to another workspace asks as in any topic, and the run resumed after that
// approval (a fresh context, as the Console gives) goes on there, then back in its own workspace,
// asking nothing more.
func TestDispatchedWorkspaceRunsAndALaterSwitchStillAsks(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	reg, reader, writer, shell := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("r1", "read_file", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("b1", "bash", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/unrelated"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w2", "write_file", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("b2", "bash", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("s2", "workspace_use", map[string]any{"path": "/ws/thread"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w3", "write_file", nil)}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 12}, DefaultPromptSpec(), WithGuard(g))
	pending, _, err := engine.Run(threadCtx(), "work in the thread", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if got := reader.calls(); len(got) != 1 || got[0] != "/ws/thread" {
		t.Fatalf("reads = %v", got)
	}
	if got := writer.calls(); len(got) != 1 || got[0] != "/ws/thread" {
		t.Fatalf("writes before the switch = %v, want one in the thread's workspace", got)
	}
	if got := shell.calls(); len(got) != 1 || got[0] != "/ws/thread" {
		t.Fatalf("commands before the switch = %v, want one in the thread's workspace", got)
	}
	// The one approval of the run is the explicit switch's.
	approvalID := pendingApprovalID(t, pending)
	rec, ok, err := store.Get(context.Background(), approvalID)
	if err != nil || !ok || rec.ToolName != "write_file" || !strings.Contains(strings.Join(rec.Reasons, " "), guard.WorkspaceSwitchReason+": /ws/unrelated") {
		t.Fatalf("approval = %+v, %v, %v", rec, ok, err)
	}
	if n := store.count(); n != 1 {
		t.Fatalf("approvals recorded = %d, want the switch's alone", n)
	}
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatal(err)
	}
	final, _, err := engine.Resume(threadCtx(), approvalID)
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Resume() = %#v, %v", final, err)
	}
	if got := writer.calls(); len(got) != 3 || got[1] != "/ws/unrelated" || got[2] != "/ws/thread" {
		t.Fatalf("writes = %v", got)
	}
	if got := shell.calls(); len(got) != 2 || got[1] != "/ws/unrelated" {
		t.Fatalf("commands = %v", got)
	}
	if n := store.count(); n != 1 {
		t.Fatalf("approvals recorded after the resume = %d, want 1", n)
	}
}

// A switch denied in a thread runs nothing in the other workspace.
func TestDispatchedWorkspaceDeniedSwitchDoesNotWrite(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	reg, _, writer, _ := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/unrelated"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil)}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g))
	pending, _, err := engine.Run(threadCtx(), "work elsewhere", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	approvalID := pendingApprovalID(t, pending)
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalDenied, "tester", ""); err != nil {
		t.Fatal(err)
	}
	if final, _, err := engine.Resume(threadCtx(), approvalID); err != nil {
		t.Fatalf("Resume() error = %v", err)
	} else if _, stillPending := final.Output.(PendingOutput); !stillPending {
		t.Fatalf("denied resume final = %#v", final)
	}
	if got := writer.calls(); len(got) != 0 {
		t.Fatalf("denied write ran: %v", got)
	}
}

// The Guard's own approvals do not depend on the workspace: a thread's command in its own
// workspace still asks when the Guard says so, and for the Guard's reason, and the resumed run
// (which keeps no workspace state, having never switched) works on in the thread's workspace.
func TestDispatchedWorkspaceKeepsGuardApprovals(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalGuard(store, nil)
	reg, _, writer, shell := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("b1", "bash", map[string]any{"cmd": "make"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w2", "write_file", nil)}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 8}, DefaultPromptSpec(), WithGuard(g))
	pending, _, err := engine.Run(threadCtx(), "build in the thread", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if got := writer.calls(); len(got) != 1 || got[0] != "/ws/thread" {
		t.Fatalf("writes before the Guard asked = %v", got)
	}
	if got := shell.calls(); len(got) != 0 {
		t.Fatalf("command ran before the Guard's approval: %v", got)
	}
	approvalID := pendingApprovalID(t, pending)
	rec, ok, err := store.Get(context.Background(), approvalID)
	if err != nil || !ok || rec.ToolName != "bash" {
		t.Fatalf("approval = %+v, %v, %v", rec, ok, err)
	}
	if reasons := strings.Join(rec.Reasons, " "); strings.Contains(reasons, guard.WorkspaceSwitchReason) {
		t.Fatalf("the Guard's approval names the workspace: %q", reasons)
	}
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatal(err)
	}
	final, _, err := engine.Resume(threadCtx(), approvalID)
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Resume() = %#v, %v", final, err)
	}
	if got := shell.calls(); len(got) != 1 || got[0] != "/ws/thread" {
		t.Fatalf("commands = %v", got)
	}
	if got := writer.calls(); len(got) != 2 || got[1] != "/ws/thread" {
		t.Fatalf("writes = %v", got)
	}
}
