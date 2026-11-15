package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestCoderTool_ExecuteCodexUsesSubtaskRunner(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	runner := &execDirectSubtaskRunner{}
	var got CoderRequest

	tool := newCoderTool(coderToolDeps{
		Runner: runner,
		Env:    fakeCoderEnv(t),
		RunSessions: func(_ context.Context, req CoderRequest) (string, error) {
			got = req
			req.Progress("", "working", "")
			return "done output", nil
		},
	})

	var events []Event
	ctx := WithEventSinkContext(context.Background(), EventSinkFunc(func(_ context.Context, event Event) {
		events = append(events, event)
	}))
	raw, err := tool.Execute(ctx, map[string]any{
		"coder": "codex",
		"task":  "inspect the repo",
		"cwd":   dir,
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if got.Backend != coderBackendCodex {
		t.Fatalf("got.Backend = %q, want %q", got.Backend, coderBackendCodex)
	}
	if got.Task != "inspect the repo" {
		t.Fatalf("got.Task = %q, want inspect the repo", got.Task)
	}
	if got.CWD != dir {
		t.Fatalf("got.CWD = %q, want %q", got.CWD, dir)
	}
	if runner.req.RunFunc == nil {
		t.Fatal("coder should run through SubtaskRunner direct path")
	}

	var result SubtaskResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatalf("json.Unmarshal(result) error = %v", err)
	}
	if result.Status != SubtaskStatusDone {
		t.Fatalf("result.Status = %q, want %q", result.Status, SubtaskStatusDone)
	}
	if result.OutputKind != SubtaskOutputKindText {
		t.Fatalf("result.OutputKind = %q, want %q", result.OutputKind, SubtaskOutputKindText)
	}
	if result.Output != "done output" {
		t.Fatalf("result.Output = %#v, want done output", result.Output)
	}

	if len(events) != 2 {
		t.Fatalf("events = %#v, want progress and final output events", events)
	}
	if events[0].Kind != EventKindToolOutput || events[0].ToolName != coderToolName || events[0].Stream != "codex" || events[0].Text != "working" {
		t.Fatalf("event = %#v, want coder codex output", events[0])
	}
}

func TestCoderTool_ReturnsFailedEnvelopeOnCLIError(t *testing.T) {
	t.Parallel()

	runner := &execDirectSubtaskRunner{}
	tool := newCoderTool(coderToolDeps{
		Runner: runner,
		Env:    fakeCoderEnv(t),
		RunSessions: func(context.Context, CoderRequest) (string, error) {
			return "partial output", errors.New("cli failed")
		},
	})

	raw, err := tool.Execute(context.Background(), map[string]any{
		"coder": "claude",
		"task":  "try it",
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	var result SubtaskResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatalf("json.Unmarshal(result) error = %v", err)
	}
	if result.Status != SubtaskStatusFailed {
		t.Fatalf("result.Status = %q, want %q", result.Status, SubtaskStatusFailed)
	}
	if result.Output != "partial output" {
		t.Fatalf("result.Output = %#v, want partial output", result.Output)
	}
	if !strings.Contains(result.Error, "cli failed") {
		t.Fatalf("result.Error = %q, want cli failed", result.Error)
	}
}

func TestCoderTool_ResolvesCWDPathAliases(t *testing.T) {
	t.Parallel()

	workspaceDir := t.TempDir()
	stateDir := t.TempDir()
	cacheDir := t.TempDir()
	stateWorkDir := filepath.Join(stateDir, "tasks", "task-a")
	workspaceWorkDir := filepath.Join(workspaceDir, "subdir")
	for _, dir := range []string{stateWorkDir, workspaceWorkDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("MkdirAll(%s) error = %v", dir, err)
		}
	}

	for _, tc := range []struct {
		name string
		cwd  string
		want string
		ctx  context.Context
	}{
		{
			name: "file state alias",
			cwd:  "file_state_dir/tasks/task-a",
			want: stateWorkDir,
			ctx:  context.Background(),
		},
		{
			name: "workspace alias",
			cwd:  "workspace_dir/subdir",
			want: workspaceWorkDir,
			ctx:  context.Background(),
		},
		{
			name: "empty defaults to workspace from context",
			cwd:  "",
			want: workspaceWorkDir,
			ctx:  pathroots.WithWorkspaceDir(context.Background(), workspaceWorkDir),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			runner := &execDirectSubtaskRunner{}
			var got CoderRequest
			tool := newCoderTool(coderToolDeps{
				Roots:  pathroots.New(workspaceDir, cacheDir, stateDir),
				Runner: runner,
				Env:    fakeCoderEnv(t),
				RunSessions: func(_ context.Context, req CoderRequest) (string, error) {
					got = req
					return "ok", nil
				},
			})

			if _, err := tool.Execute(tc.ctx, map[string]any{
				"coder": "codex",
				"task":  "inspect",
				"cwd":   tc.cwd,
			}); err != nil {
				t.Fatalf("Execute() error = %v", err)
			}
			if got.CWD != tc.want {
				t.Fatalf("got.CWD = %q, want %q", got.CWD, tc.want)
			}
		})
	}
}

func TestCoderTool_RespectsSubtaskDepthLimit(t *testing.T) {
	t.Parallel()

	runner := &localSubtaskRunner{
		engine: New(noopSubtaskClient{}, tools.NewRegistry(), Config{}, DefaultPromptSpec()),
	}
	called := false
	tool := newCoderTool(coderToolDeps{
		Runner: runner,
		Env:    fakeCoderEnv(t),
		RunSessions: func(context.Context, CoderRequest) (string, error) {
			called = true
			return "", nil
		},
	})

	raw, err := tool.Execute(WithSubtaskDepth(context.Background(), SubtaskMaxDepth), map[string]any{
		"coder": "codex",
		"task":  "try it",
		"cwd":   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if called {
		t.Fatal("coder CLI should not run after subtask depth limit is reached")
	}
	var result SubtaskResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatalf("json.Unmarshal(result) error = %v", err)
	}
	if result.Status != SubtaskStatusFailed {
		t.Fatalf("result.Status = %q, want %q", result.Status, SubtaskStatusFailed)
	}
	if !strings.Contains(result.Error, "depth limit") {
		t.Fatalf("result.Error = %q, want depth limit", result.Error)
	}
}

func TestCoderTool_RunsFromSubtaskBelowDepthLimit(t *testing.T) {
	t.Parallel()

	runner := &localSubtaskRunner{
		engine: New(noopSubtaskClient{}, tools.NewRegistry(), Config{}, DefaultPromptSpec()),
	}
	cliDepth := -1
	tool := newCoderTool(coderToolDeps{
		Runner: runner,
		Env:    fakeCoderEnv(t),
		RunSessions: func(ctx context.Context, _ CoderRequest) (string, error) {
			cliDepth = SubtaskDepthFromContext(ctx)
			return "patched", nil
		},
	})

	raw, err := tool.Execute(WithSubtaskDepth(context.Background(), SubtaskMaxDepth-1), map[string]any{
		"coder": "codex",
		"task":  "try it",
		"cwd":   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("Execute() error = %v", err)
	}
	if cliDepth != SubtaskMaxDepth {
		t.Fatalf("coder CLI depth = %d, want %d", cliDepth, SubtaskMaxDepth)
	}
	var result SubtaskResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		t.Fatalf("json.Unmarshal(result) error = %v", err)
	}
	if result.Status != SubtaskStatusDone || result.Output != "patched" {
		t.Fatalf("result = %+v, want done with CLI output", result)
	}
}

func TestCoderToolPromptGuidanceMentionsExplicitCLIRequests(t *testing.T) {
	t.Parallel()

	tool := newCoderTool(coderToolDeps{})
	desc := strings.ToLower(tool.Description())
	for _, want := range []string{"codex", "claude code", "cc"} {
		if !strings.Contains(desc, want) {
			t.Fatalf("Description() = %q, want mention %q", tool.Description(), want)
		}
	}

	var schema struct {
		Properties map[string]struct {
			Description string `json:"description"`
		} `json:"properties"`
	}
	if err := json.Unmarshal([]byte(tool.ParameterSchema()), &schema); err != nil {
		t.Fatalf("json.Unmarshal(ParameterSchema()) error = %v", err)
	}
	coderDesc := strings.ToLower(schema.Properties["coder"].Description)
	for _, want := range []string{"codex", "claude code", "cc"} {
		if !strings.Contains(coderDesc, want) {
			t.Fatalf("coder description = %q, want mention %q", schema.Properties["coder"].Description, want)
		}
	}
	taskDesc := strings.ToLower(schema.Properties["task"].Description)
	for _, want := range []string{"self-contained", "filename"} {
		if !strings.Contains(taskDesc, want) {
			t.Fatalf("task description = %q, want mention %q", schema.Properties["task"].Description, want)
		}
	}
}

func TestCoderTool_ValidateParams(t *testing.T) {
	t.Parallel()

	tool := newCoderTool(coderToolDeps{Runner: &execDirectSubtaskRunner{}})
	for _, tc := range []struct {
		name   string
		params map[string]any
		want   string
	}{
		{name: "missing coder", params: map[string]any{"task": "x"}, want: "coder"},
		{name: "missing task", params: map[string]any{"coder": "codex"}, want: "task"},
		{name: "bad coder", params: map[string]any{"coder": "other", "task": "x"}, want: "unsupported coder"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tool.Execute(context.Background(), tc.params)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("Execute() error = %v, want containing %q", err, tc.want)
			}
		})
	}
}

func writeFakeCoderExecutable(t *testing.T, dir, name, body string) {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatalf("WriteFile(%s) error = %v", name, err)
	}
}

type execDirectSubtaskRunner struct {
	req SubtaskRequest
}

func (r *execDirectSubtaskRunner) RunSubtask(ctx context.Context, req SubtaskRequest) (*SubtaskResult, error) {
	r.req = req
	if req.RunFunc == nil {
		return nil, nil
	}
	return req.RunFunc(ctx)
}

func TestCoderToolBypassApprovalsPerBackend(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}
	t.Parallel()

	bin := t.TempDir()
	for _, name := range []string{coderBackendCodex, coderBackendClaude} {
		writeFakeCoderExecutable(t, bin, name, "exit 0\n")
	}
	var got []CoderRequest
	tool := newCoderTool(coderToolDeps{
		Runner:          &execDirectSubtaskRunner{},
		Env:             shellenv.CoderEnv{PathExtra: []string{bin}},
		BypassApprovals: map[string]bool{coderBackendClaude: true},
		RunSessions: func(_ context.Context, req CoderRequest) (string, error) {
			got = append(got, req)
			return "ok", nil
		},
	})
	for _, backend := range []string{coderBackendCodex, coderBackendClaude} {
		if _, err := tool.Execute(context.Background(), map[string]any{"coder": backend, "task": "t", "cwd": t.TempDir()}); err != nil {
			t.Fatalf("%s: %v", backend, err)
		}
	}
	if len(got) != 2 || got[0].BypassApprovals || !got[1].BypassApprovals {
		t.Fatalf("requests = %+v, want only claude to bypass", got)
	}
	desc := tool.Description()
	for _, want := range []string{"keeps one session", "Only a Console conversation's sessions ask"} {
		if !strings.Contains(desc, want) {
			t.Fatalf("description = %q, want %q", desc, want)
		}
	}
	if strings.Contains(desc, "terminal") {
		t.Fatalf("description still names a terminal: %q", desc)
	}
}

// These tests inject a runner but still exercise the real executable lookup.
func fakeCoderEnv(t *testing.T) shellenv.CoderEnv {
	t.Helper()
	dir := t.TempDir()
	for _, name := range []string{"codex", "claude", "agy"} {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		if err := os.WriteFile(filepath.Join(dir, name), []byte("test executable"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	return shellenv.CoderEnv{PathExtra: []string{dir}}
}

// Every coder goes through the runtime's sessions: without them the tool says so, for Claude Code
// as for the other two, and starts no CLI of its own.
func TestCoderToolNeedsSessionsForEveryBackend(t *testing.T) {
	t.Parallel()

	for _, backend := range []string{coderBackendCodex, coderBackendClaude, coderBackendAgy} {
		tool := newCoderTool(coderToolDeps{Runner: &execDirectSubtaskRunner{}, Env: fakeCoderEnv(t)})
		_, err := tool.Execute(context.Background(), map[string]any{"coder": backend, "task": "t", "cwd": t.TempDir()})
		if err == nil || !strings.Contains(err.Error(), "coder sessions unavailable") {
			t.Fatalf("%s: error = %v", backend, err)
		}
	}
}
