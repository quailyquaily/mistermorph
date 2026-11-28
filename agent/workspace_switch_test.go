package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

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
func (t *wsRecordingTool) ParameterSchema() string { return `{"type":"object","properties":{}}` }
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
	reg, byName := wsFullRegistry()
	return reg, byName["read_file"], byName["write_file"], byName["bash"]
}

// formerlyGatedTools are the tools that, before FT196, asked the user the first time they ran in
// a workspace the run had switched to.
var formerlyGatedTools = []string{"write_file", "bash", "powershell", "coder", "spawn", "image_generate", "image_edit"}

// legacyWorkspaceSwitchReason is the reason those approvals were asked with; requests that are
// still pending from before FT196 carry it.
const legacyWorkspaceSwitchReason = "workspace_switch_requires_approval"

// wsFullRegistry registers workspace_use, read_file and every formerly gated tool, each recording
// the workspace it ran in.
func wsFullRegistry() (*tools.Registry, map[string]*wsRecordingTool) {
	reg := tools.NewRegistry()
	reg.Register(wsSwitchTool{})
	byName := map[string]*wsRecordingTool{}
	for _, name := range append([]string{"read_file"}, formerlyGatedTools...) {
		tool := &wsRecordingTool{name: name}
		byName[name] = tool
		reg.Register(tool)
	}
	return reg, byName
}

// switchedCtx is a run's context as the Console gives an owner chat run: a switch started in the
// topic's workspace.
func switchedCtx() context.Context {
	return pathroots.WithWorkspaceSwitch(context.Background(), pathroots.NewWorkspaceSwitch("/ws/topic"))
}

// wantDirs fails unless tool ran exactly in dirs, in order.
func wantDirs(t *testing.T, tool *wsRecordingTool, dirs ...string) {
	t.Helper()
	if got := tool.calls(); strings.Join(got, ",") != strings.Join(dirs, ",") {
		t.Fatalf("%s ran in %v, want %v", tool.name, got, dirs)
	}
}

// After workspace_use, an owner Console run writes and runs commands in the new workspace with no
// approval: every tool that used to ask the first time runs at once, a second switch asks
// nothing either, and no approval is recorded (so none can expire).
func TestWorkspaceSwitchAsksNothingBeforeWritesOrCommands(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	reg, byName := wsFullRegistry()
	steps := []llm.Result{
		{ToolCalls: []llm.ToolCall{call("w0", "write_file", nil)}},
		{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
		{ToolCalls: []llm.ToolCall{call("r1", "read_file", nil)}},
	}
	for i, name := range formerlyGatedTools {
		steps = append(steps, llm.Result{ToolCalls: []llm.ToolCall{call(fmt.Sprintf("g%d", i), name, nil)}})
	}
	steps = append(steps,
		llm.Result{ToolCalls: []llm.ToolCall{call("s2", "workspace_use", map[string]any{"path": "/ws/third"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w2", "write_file", nil)}},
		llm.Result{ToolCalls: []llm.ToolCall{call("b2", "bash", nil)}},
		finalResponse("done"),
	)
	client := newMockClient(steps...)
	engine := New(client, reg, Config{MaxSteps: 20}, DefaultPromptSpec(), WithGuard(g))

	final, _, err := engine.Run(switchedCtx(), "work elsewhere", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	if final == nil || final.Output != "done" {
		t.Fatalf("final = %#v, want done with no approval asked", final)
	}
	if n := store.count(); n != 0 {
		t.Fatalf("approvals recorded = %d, want none", n)
	}
	wantDirs(t, byName["read_file"], "/ws/other")
	wantDirs(t, byName["write_file"], "/ws/topic", "/ws/other", "/ws/third")
	wantDirs(t, byName["bash"], "/ws/other", "/ws/third")
	for _, name := range formerlyGatedTools[2:] {
		if name == "spawn" {
			continue
		}
		wantDirs(t, byName[name], "/ws/other")
	}
	// The engine puts its own spawn tool in place of the stand-in: the call reached it (and failed
	// on its missing task) rather than waiting for an approval. A subtask's workspace is the one the
	// parent uses when it starts (TestSubtaskWorksInAFixedWorkspace).
	spawnID := fmt.Sprintf("g%d", slices.Index(formerlyGatedTools, "spawn"))
	if got := lastToolObservation(client.allCalls()[len(client.allCalls())-1], spawnID); !strings.Contains(got, "missing required param: task") {
		t.Fatalf("spawn observation = %q", got)
	}
}

// Without any approval store (no guard at all), a switched run still writes and runs commands:
// the switch never needed one.
func TestWorkspaceSwitchRunsWithoutAnApprovalStore(t *testing.T) {
	reg, _, writer, shell := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil), call("b1", "bash", nil)}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec())
	final, _, err := engine.Run(switchedCtx(), "work elsewhere", RunOptions{})
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Run() = %#v, %v", final, err)
	}
	wantDirs(t, writer, "/ws/other")
	wantDirs(t, shell, "/ws/other")
}

// Calls in the same batch as workspace_use, after it, run in the workspace it switched to.
func TestCallsBatchedAfterTheSwitchRunThere(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	reg, _, writer, shell := wsRegistry()
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{
			call("s1", "workspace_use", map[string]any{"path": "/ws/other"}),
			call("w1", "write_file", nil),
			call("b1", "bash", nil),
		}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g))
	final, _, err := engine.Run(switchedCtx(), "work elsewhere", RunOptions{})
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Run() = %#v, %v", final, err)
	}
	wantDirs(t, writer, "/ws/other")
	wantDirs(t, shell, "/ws/other")
	for _, msg := range client.allCalls()[1].Messages {
		if msg.Role == "tool" && (msg.ToolCallID == "w1" || msg.ToolCallID == "b1") && msg.Content != "ok" {
			t.Fatalf("%s observation = %q", msg.ToolCallID, msg.Content)
		}
	}
	if n := store.count(); n != 0 {
		t.Fatalf("approvals recorded = %d, want none", n)
	}
}

// The check codemode runs on each nested call asks nothing for a switched workspace, with or
// without an approval store.
func TestCodemodeCheckAllowsWritesInASwitchedWorkspace(t *testing.T) {
	for label, opts := range map[string][]Option{
		"approvals-only": {WithGuard(approvalsOnlyGuard(newMemoryApprovalStore()))},
		"no guard":       nil,
	} {
		t.Run(label, func(t *testing.T) {
			ctx := switchedCtx()
			sw, _ := pathroots.WorkspaceSwitchFromContext(ctx)
			sw.Use("/ws/other")
			e := New(nil, tools.NewRegistry(), Config{}, DefaultPromptSpec(), opts...)
			st := &engineLoopState{runID: "r"}
			for _, name := range append([]string{"read_file"}, formerlyGatedTools...) {
				observation, denied, approval, err := e.guardDecide(ctx, st, 1, &ToolCall{Name: name}, "")
				if err != nil || denied || approval != nil || observation != "" {
					t.Fatalf("decide %s = %q, %v, %+v, %v", name, observation, denied, approval, err)
				}
			}
		})
	}
}

// A codemode script after a switch writes in the new workspace (scripts cannot run commands).
func TestCodemodeScriptRunsInTheSwitchedWorkspace(t *testing.T) {
	store := newMemoryApprovalStore()
	reg, byName := wsFullRegistry()
	writer, editor := byName["write_file"], byName["image_edit"]
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
		codeCall(`await tools.write_file({}); await tools.image_edit({}); return "ok"`),
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithCodeMode(CodeModeOptions{}), WithGuard(approvalsOnlyGuard(store)))
	final, _, err := engine.Run(switchedCtx(), "work elsewhere", RunOptions{})
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Run() = %#v, %v", final, err)
	}
	if out := codeObservation(t, client.allCalls()[2]); out.Status != "completed" {
		t.Fatalf("codemode observation = %+v", out)
	}
	wantDirs(t, writer, "/ws/other")
	wantDirs(t, editor, "/ws/other")
	if n := store.count(); n != 0 {
		t.Fatalf("approvals recorded = %d, want none", n)
	}
}

// The Guard's approvals do not depend on the switch: after workspace_use, a command the Guard asks
// about pauses for the Guard's reason (and nothing names the workspace), and the run resumed after
// that approval, with a fresh context as the Console gives, goes on in the workspace it switched
// to. A denied one runs nothing.
func TestGuardApprovalAfterASwitchResumesInTheSwitchedWorkspace(t *testing.T) {
	for _, status := range []guard.ApprovalStatus{guard.ApprovalApproved, guard.ApprovalDenied} {
		t.Run(string(status), func(t *testing.T) {
			store := newMemoryApprovalStore()
			g := approvalGuard(store, nil)
			reg, _, writer, shell := wsRegistry()
			client := newMockClient(
				llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
				llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil)}},
				llm.Result{ToolCalls: []llm.ToolCall{call("b1", "bash", map[string]any{"cmd": "make"})}},
				llm.Result{ToolCalls: []llm.ToolCall{call("w2", "write_file", nil)}},
				finalResponse("done"),
			)
			engine := New(client, reg, Config{MaxSteps: 8}, DefaultPromptSpec(), WithGuard(g))
			pending, _, err := engine.Run(switchedCtx(), "build elsewhere", RunOptions{})
			if err != nil {
				t.Fatalf("Run() error = %v", err)
			}
			wantDirs(t, writer, "/ws/other")
			wantDirs(t, shell)
			approvalID := pendingApprovalID(t, pending)
			rec, _, _ := store.Get(context.Background(), approvalID)
			if reasons := strings.Join(rec.Reasons, " "); rec.ToolName != "bash" || strings.Contains(reasons, legacyWorkspaceSwitchReason) || strings.Contains(reasons, "/ws/other") {
				t.Fatalf("approval = %s for %q", rec.ToolName, reasons)
			}
			if err := g.ResolveApproval(context.Background(), approvalID, status, "tester", ""); err != nil {
				t.Fatal(err)
			}
			final, _, err := engine.Resume(switchedCtx(), approvalID)
			if err != nil {
				t.Fatalf("Resume() error = %v", err)
			}
			if status == guard.ApprovalDenied {
				if _, stillPending := final.Output.(PendingOutput); !stillPending {
					t.Fatalf("denied resume final = %#v", final)
				}
				wantDirs(t, shell)
				wantDirs(t, writer, "/ws/other")
				return
			}
			if final == nil || final.Output != "done" {
				t.Fatalf("final = %#v", final)
			}
			wantDirs(t, shell, "/ws/other")
			wantDirs(t, writer, "/ws/other", "/ws/other")
			if n := store.count(); n != 1 {
				t.Fatalf("approvals recorded = %d, want the Guard's alone", n)
			}
		})
	}
}

// A forced-approval tool still asks after a switch, even on an approvals-only guard, and the run
// resumed after it goes on in the switched workspace.
func TestForcedApprovalToolStillAsksAfterASwitch(t *testing.T) {
	store := newMemoryApprovalStore()
	g := approvalsOnlyGuard(store)
	reg, _, writer, _ := wsRegistry()
	installer := &wsRecordingTool{name: "skill_install"}
	reg.Register(installer)
	client := newMockClient(
		llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("i1", "skill_install", map[string]any{"preview_id": "p1"})}},
		llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil)}},
		finalResponse("done"),
	)
	engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g))
	pending, _, err := engine.Run(switchedCtx(), "install it", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	wantDirs(t, installer)
	approvalID := pendingApprovalID(t, pending)
	rec, _, _ := store.Get(context.Background(), approvalID)
	if rec.ToolName != "skill_install" || strings.Join(rec.Reasons, " ") != "skill_install_requires_approval" {
		t.Fatalf("approval = %s for %q", rec.ToolName, rec.Reasons)
	}
	if err := g.ResolveApproval(context.Background(), approvalID, guard.ApprovalApproved, "tester", ""); err != nil {
		t.Fatal(err)
	}
	final, _, err := engine.Resume(switchedCtx(), approvalID)
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Resume() = %#v, %v", final, err)
	}
	wantDirs(t, installer, "/ws/other")
	wantDirs(t, writer, "/ws/other")
}

// makeLegacyWorkspaceApproval leaves in store what a version before FT196 left pending after a
// switch: a forced approval for a command in /ws/other with the workspace-switch reason, whose
// resume state keeps the switch and the "approved" list. It is made from a real pause (so its
// resume state and action hash are the engine's), then given the old reason and state.
func makeLegacyWorkspaceApproval(t *testing.T, store *memoryApprovalStore, engine *Engine) string {
	t.Helper()
	pending, _, err := engine.Run(switchedCtx(), "build elsewhere", RunOptions{})
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	approvalID := pendingApprovalID(t, pending)
	store.mu.Lock()
	defer store.mu.Unlock()
	rec := store.records[approvalID]
	var state map[string]any
	if err := json.Unmarshal(rec.ResumeState, &state); err != nil {
		t.Fatal(err)
	}
	if ws, _ := state["workspace"].(map[string]any); ws == nil || ws["current"] != "/ws/other" {
		t.Fatalf("resume state workspace = %v", state["workspace"])
	}
	state["workspace"] = map[string]any{"current": "/ws/other", "approved": []string{"/ws/elsewhere"}}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	rec.ResumeState = raw
	rec.RiskLevel = guard.RiskHigh
	rec.Reasons = []string{legacyWorkspaceSwitchReason + ": /ws/other"}
	store.records[approvalID] = rec
	return approvalID
}

// An approval of the removed kind that is still pending after an upgrade is neither dropped nor
// approved on its own: it stays pending until the user answers it, a denial runs nothing, an
// expired one cannot resume, and an approved one runs its call in the workspace the run had
// switched to and goes on there asking nothing more.
func TestLegacyWorkspaceApprovalResolvesNormally(t *testing.T) {
	for _, outcome := range []string{"pending", "approved", "denied", "expired"} {
		t.Run(outcome, func(t *testing.T) {
			store := newMemoryApprovalStore()
			reg, _, writer, shell := wsRegistry()
			client := newMockClient(
				llm.Result{ToolCalls: []llm.ToolCall{call("s1", "workspace_use", map[string]any{"path": "/ws/other"})}},
				llm.Result{ToolCalls: []llm.ToolCall{call("b1", "bash", map[string]any{"cmd": "make"})}},
				llm.Result{ToolCalls: []llm.ToolCall{call("w1", "write_file", nil)}},
				finalResponse("done"),
			)
			// The pause comes from an enabled Guard; the resume runs as the old forced approval
			// did, on an approvals-only guard over the same store.
			approvalID := makeLegacyWorkspaceApproval(t, store, New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(approvalGuard(store, nil))))
			g := approvalsOnlyGuard(store)
			engine := New(client, reg, Config{MaxSteps: 6}, DefaultPromptSpec(), WithGuard(g))
			switch outcome {
			case "approved", "denied":
				status := guard.ApprovalApproved
				if outcome == "denied" {
					status = guard.ApprovalDenied
				}
				if err := g.ResolveApproval(context.Background(), approvalID, status, "tester", ""); err != nil {
					t.Fatal(err)
				}
			case "expired":
				store.mu.Lock()
				rec := store.records[approvalID]
				rec.ExpiresAt = time.Now().Add(-time.Minute)
				store.records[approvalID] = rec
				store.mu.Unlock()
			}
			final, _, err := engine.Resume(switchedCtx(), approvalID)
			rec, ok, _ := store.Get(context.Background(), approvalID)
			if !ok {
				t.Fatal("the legacy approval was dropped")
			}
			switch outcome {
			case "pending", "denied":
				if err != nil {
					t.Fatalf("Resume() error = %v", err)
				}
				if _, stillPending := final.Output.(PendingOutput); !stillPending {
					t.Fatalf("%s resume final = %#v", outcome, final)
				}
				if want := map[string]guard.ApprovalStatus{"pending": guard.ApprovalPending, "denied": guard.ApprovalDenied}[outcome]; rec.Status != want {
					t.Fatalf("status = %s, want %s", rec.Status, want)
				}
				wantDirs(t, shell)
				wantDirs(t, writer)
			case "expired":
				if err == nil || !strings.Contains(err.Error(), "expired") {
					t.Fatalf("Resume() = %#v, %v, want expired", final, err)
				}
				wantDirs(t, shell)
			case "approved":
				if err != nil || final == nil || final.Output != "done" {
					t.Fatalf("Resume() = %#v, %v", final, err)
				}
				wantDirs(t, shell, "/ws/other")
				wantDirs(t, writer, "/ws/other")
				if n := store.count(); n != 1 {
					t.Fatalf("approvals recorded = %d, want the legacy one alone", n)
				}
			}
		})
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

// A work thread Solo started runs in the workspace Solo chose for it as its own, and after a
// workspace_use to another workspace too: none of the formerly gated tools asks, and no approval
// is recorded (so none expires).
func TestDispatchedWorkspaceNeedsNoWorkspaceApproval(t *testing.T) {
	store := newMemoryApprovalStore()
	e := New(nil, tools.NewRegistry(), Config{}, DefaultPromptSpec(), WithGuard(approvalsOnlyGuard(store)))
	for _, name := range formerlyGatedTools {
		t.Run(name, func(t *testing.T) {
			ctx := threadCtx()
			st := &engineLoopState{runID: "r"}
			observation, denied, approval, err := e.guardDecide(ctx, st, 1, &ToolCall{Name: name}, "")
			if err != nil || denied || approval != nil || observation != "" {
				t.Fatalf("decide in the thread's workspace = %q, %v, %v, %v", observation, denied, approval, err)
			}
			sw, _ := pathroots.WorkspaceSwitchFromContext(ctx)
			sw.Use("/ws/unrelated")
			observation, denied, approval, err = e.guardDecide(ctx, st, 2, &ToolCall{Name: name}, "")
			if err != nil || denied || approval != nil || observation != "" {
				t.Fatalf("decide after a switch = %q, %v, %+v, %v", observation, denied, approval, err)
			}
		})
	}
	if n := store.count(); n != 0 {
		t.Fatalf("approvals recorded = %d, want none", n)
	}
}

// The whole of a thread's run: it writes and runs commands in its own workspace, then in another
// one after workspace_use, then back in its own, and never pauses.
func TestDispatchedWorkspaceRunsAndALaterSwitchAsksNothing(t *testing.T) {
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
	final, _, err := engine.Run(threadCtx(), "work in the thread", RunOptions{})
	if err != nil || final == nil || final.Output != "done" {
		t.Fatalf("Run() = %#v, %v", final, err)
	}
	wantDirs(t, reader, "/ws/thread")
	wantDirs(t, writer, "/ws/thread", "/ws/unrelated", "/ws/thread")
	wantDirs(t, shell, "/ws/thread", "/ws/unrelated")
	if n := store.count(); n != 0 {
		t.Fatalf("approvals recorded = %d, want none", n)
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
	if reasons := strings.Join(rec.Reasons, " "); strings.Contains(reasons, legacyWorkspaceSwitchReason) {
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
