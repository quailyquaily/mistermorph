package consolecmd

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/agent"
	"github.com/quailyquaily/mistermorph/guard"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/llm"
	"github.com/quailyquaily/mistermorph/tools"
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

// engineShellRun is what one run of the real engine left behind: the activity the Console
// persists for the task, and the completion events the engine emitted.
type engineShellRun struct {
	history []consoleActivityEntry
	done    []agent.Event
}

func (r engineShellRun) entry(t *testing.T, name string) consoleActivityEntry {
	t.Helper()
	for _, entry := range r.history {
		if entry.Name == name {
			return entry
		}
	}
	t.Fatalf("no %s entry in %+v", name, r.history)
	return consoleActivityEntry{}
}

// runEngineShellCalls runs the real engine with the real bash tool: the model makes the given tool
// calls, one per step, then answers. The engine's events reach the Console's preview sink as in a
// Console task, so the observation is the one the engine frames (and Guard redacts), not the
// tool's bare return value.
func runEngineShellCalls(t *testing.T, guarded, codeMode bool, calls ...llm.ToolCall) engineShellRun {
	t.Helper()
	reg := tools.NewRegistry()
	if err := reg.Register(builtin.NewBashTool(true, 5*time.Second, 4096, pathroots.PathRoots{})); err != nil {
		t.Fatal(err)
	}
	g := guard.New(guard.Config{Enabled: guarded}, nil, nil)
	opts := []agent.Option{agent.WithGuard(g)}
	if codeMode {
		opts = append(opts, agent.WithCodeMode(agent.CodeModeOptions{}))
	}
	step := 0
	client := topicNamingClientFunc(func(context.Context, llm.Request) (llm.Result, error) {
		defer func() { step++ }()
		if step < len(calls) {
			return llm.Result{ToolCalls: []llm.ToolCall{calls[step]}}, nil
		}
		return llm.Result{Text: `{"type":"final","reasoning":"t","output":"done"}`}, nil
	})
	engine := agent.New(client, reg, agent.Config{MaxSteps: len(calls) + 2}, agent.DefaultPromptSpec(), opts...)

	hub := newConsoleStreamHub()
	sink := newConsoleEventPreviewSink(hub, "task", nil, g)
	defer sink.Close()
	var run engineShellRun
	ctx := agent.WithEventSinkContext(context.Background(), agent.EventSinkFunc(func(ctx context.Context, event agent.Event) {
		if event.Kind == agent.EventKindToolDone {
			run.done = append(run.done, event)
		}
		sink.HandleEvent(ctx, event)
	}))
	if _, _, err := engine.Run(ctx, "run the command", agent.RunOptions{}); err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	frame, _ := hub.Latest("task")
	raw, err := json.Marshal(buildConsoleTaskResult(nil, nil, frame.Activity, ""))
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Activity consoleActivityProgress `json:"activity"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	run.history = result.Activity.History
	return run
}

func bashCall(cmd string) llm.ToolCall {
	return llm.ToolCall{ID: "direct", Name: "bash", Arguments: map[string]any{"cmd": cmd}}
}

// engineShellModes are the engine setups a failed command must read the same in. With codemode on,
// a script first tries the command (scripts may not run bash) and the model then calls bash
// directly, as the codemode prompt tells it to.
func engineShellModes(t *testing.T, check func(t *testing.T, run func(cmd string) engineShellRun, guarded bool)) {
	for _, guarded := range []bool{false, true} {
		for _, codeMode := range []bool{false, true} {
			name := "guard off"
			if guarded {
				name = "guard on"
			}
			if codeMode {
				name += ", codemode"
			}
			t.Run(name, func(t *testing.T) {
				check(t, func(cmd string) engineShellRun {
					if !codeMode {
						return runEngineShellCalls(t, guarded, false, bashCall(cmd))
					}
					script, _ := json.Marshal(cmd)
					run := runEngineShellCalls(t, guarded, true,
						llm.ToolCall{ID: "script", Name: "codemode", Arguments: map[string]any{"code": "return await tools.bash({cmd: " + string(script) + "});"}},
						bashCall(cmd))
					// The script's refused call is not a command result.
					if entry := run.entry(t, "codemode"); entry.Shell != nil {
						t.Fatalf("codemode entry has a shell result: %+v", entry.Shell)
					} else {
						for _, child := range entry.Children {
							if child.Shell != nil {
								t.Fatalf("refused script call has a shell result: %+v", child.Shell)
							}
						}
					}
					return run
				}, guarded)
			})
		}
	}
}

// The engine ends a failed call's observation with "error: <tool error>" for the model. Progress
// shows what the command printed: that ending is neither stderr nor stdout.
func TestEngineShellFailureShowsOnlyCommandOutput(t *testing.T) {
	cases := []struct {
		name       string
		cmd        string
		wantExit   int
		wantStdout string
		wantStderr string
	}{
		{name: "stderr and exit 128", cmd: "printf 'fatal: not a git repository (or any of the parent directories): .git\\n' >&2; exit 128",
			wantExit: 128, wantStderr: "fatal: not a git repository (or any of the parent directories): .git\n"},
		{name: "stdout only", cmd: "printf '1 test failed\\n'; exit 1", wantExit: 1, wantStdout: "1 test failed\n"},
		{name: "no output", cmd: "exit 3", wantExit: 3},
		{name: "multiline stderr ending in blank lines", cmd: "printf 'error: first\\n\\nerror: second\\n\\n' >&2; exit 2",
			wantExit: 2, wantStderr: "error: first\n\nerror: second\n\n"},
		{name: "the command prints the engine's words", cmd: "printf 'x\\n\\nerror: bash exited with code 4' >&2; exit 4",
			wantExit: 4, wantStderr: "x\n\nerror: bash exited with code 4"},
	}
	engineShellModes(t, func(t *testing.T, run func(string) engineShellRun, _ bool) {
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				got := run(tc.cmd)
				// The engine did frame the observation: this is the path under test.
				last := got.done[len(got.done)-1]
				if last.ToolName != "bash" || !strings.HasSuffix(last.Text, "\n\nerror: "+last.Error) || last.Error == "" {
					t.Fatalf("engine completion = %+v, want the observation to end with its error", last)
				}
				entry := got.entry(t, "bash")
				if entry.Status != "failed" || entry.Args["cmd"] != tc.cmd {
					t.Fatalf("entry = %+v", entry)
				}
				want := consoleShellResult{ExitCode: tc.wantExit, Stdout: tc.wantStdout, Stderr: tc.wantStderr}
				if entry.Shell == nil || *entry.Shell != want {
					t.Fatalf("shell = %+v, want %+v", entry.Shell, want)
				}
			})
		}
	})
}

func TestEngineShellSuccessKeepsNoDiagnostics(t *testing.T) {
	engineShellModes(t, func(t *testing.T, run func(string) engineShellRun, _ bool) {
		entry := run("printf 'all good\\n'; printf 'warning: slow\\n' >&2").entry(t, "bash")
		if entry.Status != "done" || entry.Shell != nil || entry.Error != "" {
			t.Fatalf("successful call = %+v", entry)
		}
	})
}

// Guard redacts the framed observation whole; the command's output stays, redacted, and the
// engine's ending still goes.
func TestEngineShellFailureKeepsRedactedOutput(t *testing.T) {
	const secret = "abcdefghijklmnopqrstuvwxyz0123"
	engineShellModes(t, func(t *testing.T, run func(string) engineShellRun, guarded bool) {
		entry := run("printf 'denied for Authorization: Bearer "+secret+"\\n' >&2; exit 22").entry(t, "bash")
		if entry.Shell == nil || entry.Shell.ExitCode != 22 || entry.Shell.Stdout != "" {
			t.Fatalf("shell = %+v", entry.Shell)
		}
		stderr := entry.Shell.Stderr
		if !strings.HasPrefix(stderr, "denied for Authorization: Bearer ") || !strings.HasSuffix(stderr, "\n") || strings.Contains(stderr, "exited with code") {
			t.Fatalf("stderr = %q", stderr)
		}
		raw, _ := json.Marshal(entry)
		if leaked := strings.Contains(string(raw), secret); leaked == guarded {
			t.Fatalf("secret shown = %v in %s", leaked, raw)
		}
	})
}
