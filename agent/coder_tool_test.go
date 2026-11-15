package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/shellenv"
	"github.com/quailyquaily/mistermorph/tools"
)

func TestCoderTool_ExecuteCodexUsesSubtaskRunner(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	runner := &execDirectSubtaskRunner{}
	var got CoderRequest

	tool := newTestCoderTool(coderToolDeps{
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
	tool := newTestCoderTool(coderToolDeps{
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
			tool := newTestCoderTool(coderToolDeps{
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
	tool := newTestCoderTool(coderToolDeps{
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
	tool := newTestCoderTool(coderToolDeps{
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

	tool := newTestCoderTool(coderToolDeps{})
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

	tool := newTestCoderTool(coderToolDeps{Runner: &execDirectSubtaskRunner{}})
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
	tool := newTestCoderTool(coderToolDeps{
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
	if desc := tool.Description(); !strings.Contains(desc, "Claude Code keeps a terminal session") {
		t.Fatalf("description = %q", desc)
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

func TestRunCoderCLISendsClaudeTaskOnStdin(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake shell executable uses /bin/sh")
	}

	binDir := t.TempDir()
	writeFakeCoderExecutable(t, binDir, "claude", "for arg in \"$@\"; do case \"$arg\" in -*fix*) printf 'task in argv\\n' >&2; exit 9 ;; esac; done\nIFS= read -r task\nprintf '{\"type\":\"result\",\"result\":\"got %s\"}\\n' \"$task\"\n")
	output, err := runCoderCLI(context.Background(), CoderRequest{
		Backend:  coderBackendClaude,
		Task:     "- fix the bug",
		CWD:      t.TempDir(),
		LogRoot:  t.TempDir(),
		CoderEnv: shellenv.CoderEnv{PathExtra: []string{binDir}},
	}, nil)
	if err != nil {
		t.Fatalf("runCoderCLI() error = %v", err)
	}
	if output != "got - fix the bug" {
		t.Fatalf("output = %q, want got - fix the bug", output)
	}
}

func TestCoderStreamCollectorClaude(t *testing.T) {
	t.Parallel()

	var chunks []string
	collector := newCoderStreamCollector(coderBackendClaude, func(text string) {
		chunks = append(chunks, text)
	})
	for _, line := range []string{
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"hel"}}}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hello"}]}}`,
		`{"type":"result","result":"hello final","is_error":false}`,
	} {
		if err := collector.ConsumeLine([]byte(line)); err != nil {
			t.Fatalf("ConsumeLine(%s) error = %v", line, err)
		}
	}
	if got := strings.Join(chunks, ""); got != "hello" {
		t.Fatalf("chunks = %#v joined %q, want hello", chunks, got)
	}
	if got := collector.Output(); got != "hello final" {
		t.Fatalf("collector.Output() = %q, want hello final", got)
	}
}

func TestCoderStreamCollectorClaudeToolProgress(t *testing.T) {
	var chunks []string
	collector := newCoderStreamCollector(coderBackendClaude, func(text string) { chunks = append(chunks, text) })
	for _, line := range []string{
		`{"type":"system","subtype":"init","session_id":"session-1"}`,
		`{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"tool_use","id":"tool-1","name":"Read","input":{}}}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tool-1","name":"Read","input":{"file_path":"source.go"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tool-1","content":"source content"}]}}`,
		`{"type":"result","result":"finished","is_error":false}`,
	} {
		if err := collector.ConsumeLine([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	progress := strings.Join(chunks, "")
	for _, want := range []string{"init", "Read", "source.go", "tool-1", "completed"} {
		if !strings.Contains(progress, want) {
			t.Fatalf("progress %q missing %q", progress, want)
		}
	}
	if collector.Output() != "finished" {
		t.Fatalf("output = %q", collector.Output())
	}
}

func TestRunClaudeTimeoutPreservesDiagnostics(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("fake executable uses /bin/sh")
	}
	binDir := t.TempDir()
	logRoot := t.TempDir()
	writeFakeCoderExecutable(t, binDir, "claude", "while [ $# -gt 0 ]; do\n  if [ \"$1\" = '--debug-file' ]; then shift; printf 'debug enabled\\n' > \"$1\"; fi\n  shift\ndone\nprintf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\"}'\nprintf 'waiting for upstream\\n' >&2\nexec sleep 10\n")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	var chunks []string
	_, err := runCoderCLI(ctx, CoderRequest{Backend: coderBackendClaude, Task: "x", CWD: t.TempDir(), LogRoot: logRoot, CoderEnv: shellenv.CoderEnv{PathExtra: []string{binDir}}}, func(text string) { chunks = append(chunks, text) })
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error = %v", err)
	}
	for _, want := range []string{"waiting for upstream", "init", "diagnostics:"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("error %q missing %q", err, want)
		}
	}
	progress := strings.Join(chunks, "")
	if !strings.Contains(progress, "waiting for upstream") {
		t.Fatalf("stderr not streamed: %q", progress)
	}
	dirs, err := filepath.Glob(filepath.Join(logRoot, "coder", "claude-*"))
	if err != nil || len(dirs) != 1 {
		t.Fatalf("diagnostic directories = %v, err=%v", dirs, err)
	}
	for name, want := range map[string]string{"stdout.jsonl": `"subtype":"init"`, "stderr.log": "waiting for upstream", "debug.log": "debug enabled"} {
		data, err := os.ReadFile(filepath.Join(dirs[0], name))
		if err != nil || !strings.Contains(string(data), want) {
			t.Fatalf("%s = %q, err=%v", name, data, err)
		}
	}
}

func TestCoderStreamCollectorClaudeSteps(t *testing.T) {
	t.Parallel()

	var steps []string
	collector := newCoderStreamCollector(coderBackendClaude, nil)
	collector.progress = func(_, _, step string) { steps = append(steps, step) }
	for _, line := range []string{
		`{"type":"system","subtype":"init"}`,
		`{"type":"stream_event","event":{"type":"content_block_start","content_block":{"type":"thinking"}}}`,
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"private.go"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"ok"}]}}`,
		`{"type":"tool_progress","tool_name":"Bash","tool_use_id":"t2","elapsed_time_seconds":30}`,
		`{"type":"tool_progress","tool_name":"mcp__github__create_issue","tool_use_id":"t3","elapsed_time_seconds":1}`,
		`{"type":"tool_progress","tool_name":"Skill","tool_use_id":"t4","elapsed_time_seconds":1}`,
	} {
		if err := collector.ConsumeLine([]byte(line)); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{coderStepStarting, coderStepThinking, coderStepEdit, coderStepThinking, coderStepCommand, coderStepTool, "using Skill"}
	if !reflect.DeepEqual(steps, want) {
		t.Fatalf("steps = %q, want %q", steps, want)
	}
}

func newTestCoderTool(deps coderToolDeps) *coderTool {
	if deps.RunTerminal == nil {
		deps.RunTerminal = deps.RunSessions
	}
	return newCoderTool(deps)
}
