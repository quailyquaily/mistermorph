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
	"github.com/quailyquaily/mistermorph/tools/builtin"
)

// runConsoleShellCall runs cmd with the real bash tool and feeds its start and completion, as the
// engine emits them, to a preview sink; it returns the activity the Console persists for the task
// (the task result's JSON, read back).
func runConsoleShellCall(t *testing.T, sink *consoleEventPreviewSink, hub *consoleStreamHub, id string, params map[string]any, maxOutputBytes int) consoleActivityEntry {
	t.Helper()
	cmd, _ := params["cmd"].(string)
	args := map[string]any{"cmd": strings.TrimSpace(cmd)}
	sink.HandleEvent(context.Background(), agent.Event{Kind: agent.EventKindToolStart, ActivityID: id, ToolName: "bash", Status: "running", Args: args})
	tool := builtin.NewBashTool(true, 5*time.Second, maxOutputBytes, pathroots.PathRoots{})
	observation, err := tool.Execute(context.Background(), params)
	status, errText := "done", ""
	if err != nil {
		status, errText = "failed", err.Error()
	}
	sink.HandleEvent(context.Background(), agent.Event{
		Kind: agent.EventKindToolDone, ActivityID: id, ToolName: "bash", Status: status, Text: observation, Error: errText, Args: args,
	})
	frame, _ := hub.Latest("task")
	return persistedConsoleEntry(t, frame.Activity, id)
}

func persistedConsoleEntry(t *testing.T, activity *consoleActivityProgress, id string) consoleActivityEntry {
	t.Helper()
	raw, err := json.Marshal(buildConsoleTaskResult(nil, nil, activity, ""))
	if err != nil {
		t.Fatal(err)
	}
	var result struct {
		Activity consoleActivityProgress `json:"activity"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	for _, entry := range result.Activity.History {
		if entry.ID == id {
			return entry
		}
	}
	t.Fatalf("no entry %q in %s", id, raw)
	return consoleActivityEntry{}
}

func newConsoleShellSink(guarded bool) (*consoleEventPreviewSink, *consoleStreamHub) {
	hub := newConsoleStreamHub()
	return newConsoleEventPreviewSink(hub, "task", nil, guard.New(guard.Config{Enabled: guarded}, nil, nil)), hub
}

func TestConsoleShellFailureKeepsDiagnostics(t *testing.T) {
	// A long multi-line command, as the engine shows it (whole, line breaks kept).
	longCmd := "set -e\n" + strings.Repeat("echo preparing the checkout before the fetch >/dev/null\n", 20) +
		"printf 'fatal: unable to access remote: Could not resolve host: example.invalid\\n' >&2\nexit 128"
	cases := []struct {
		name       string
		cmd        string
		wantExit   int
		wantStdout string
		wantStderr string
	}{
		{name: "git fatal on stderr, exit 128", cmd: longCmd, wantExit: 128, wantStderr: "fatal: unable to access remote: Could not resolve host: example.invalid\n"},
		{name: "stdout only", cmd: "printf '1 test failed\\n'; exit 1", wantExit: 1, wantStdout: "1 test failed\n"},
		{name: "no output", cmd: "exit 3", wantExit: 3},
	}
	for _, guarded := range []bool{false, true} {
		for _, tc := range cases {
			t.Run(tc.name, func(t *testing.T) {
				sink, hub := newConsoleShellSink(guarded)
				defer sink.Close()
				entry := runConsoleShellCall(t, sink, hub, "call", map[string]any{"cmd": tc.cmd}, 4096)
				if entry.Status != "failed" {
					t.Fatalf("status = %q, want failed", entry.Status)
				}
				if entry.Args["cmd"] != strings.TrimSpace(tc.cmd) {
					t.Fatalf("cmd = %q, want the whole command", entry.Args["cmd"])
				}
				want := consoleShellResult{ExitCode: tc.wantExit, Stdout: tc.wantStdout, Stderr: tc.wantStderr}
				if entry.Shell == nil || *entry.Shell != want {
					t.Fatalf("shell = %+v, want %+v", entry.Shell, want)
				}
			})
		}
	}
}

func TestConsoleShellSuccessKeepsNoDiagnostics(t *testing.T) {
	for _, guarded := range []bool{false, true} {
		sink, hub := newConsoleShellSink(guarded)
		entry := runConsoleShellCall(t, sink, hub, "ok", map[string]any{"cmd": "printf 'all good\\n'"}, 4096)
		sink.Close()
		if entry.Status != "done" || entry.Shell != nil || entry.Error != "" || entry.Args["cmd"] != "printf 'all good\\n'" {
			t.Fatalf("guarded=%v: successful call = %+v", guarded, entry)
		}
	}
}

func TestConsoleShellDiagnosticsSurviveLaterEvents(t *testing.T) {
	sink, hub := newConsoleShellSink(false)
	defer sink.Close()
	// Run as a subtask: the call's result is the subtask envelope, and the subtask's own events
	// carry only the generic exit message.
	params := map[string]any{"cmd": "printf 'error: pathspec main did not match\\n' >&2; exit 1", "run_in_subtask": true}
	entry := runConsoleShellCall(t, sink, hub, "sub", params, 4096)
	want := consoleShellResult{ExitCode: 1, Stderr: "error: pathspec main did not match\n"}
	if entry.Shell == nil || *entry.Shell != want {
		t.Fatalf("shell = %+v, want %+v", entry.Shell, want)
	}
	// Completion and status events later never replace it with a generic status.
	for _, event := range []agent.Event{
		{Kind: agent.EventKindToolDone, ActivityID: "sub", ToolName: "bash", Status: "failed", Error: "bash exited with code 1"},
		{Kind: agent.EventKindToolDone, ActivityID: "sub", ToolName: "bash", Status: "failed", Text: "Error: blocked by guard (tool output)"},
		{Kind: agent.EventKindSubtaskDone, ActivityID: "sub", TaskID: "sub", Status: "failed", Summary: "bash exited with code 1"},
	} {
		sink.HandleEvent(context.Background(), event)
	}
	frame, _ := hub.Latest("task")
	if got := persistedConsoleEntry(t, frame.Activity, "sub"); got.Shell == nil || *got.Shell != want {
		t.Fatalf("after later events shell = %+v, want %+v", got.Shell, want)
	}
}

func TestConsoleShellDiagnosticsLimits(t *testing.T) {
	sink, hub := newConsoleShellSink(false)
	defer sink.Close()
	// More stderr than the Console keeps: its end (where the cause is) stays, the rest is counted.
	extra := 25
	cmd := "head -c " + itoa(consoleActivityOutputMaxChars+extra) + " /dev/zero | tr '\\0' x >&2; printf '\\nfatal: the end' >&2; exit 128"
	entry := runConsoleShellCall(t, sink, hub, "big", map[string]any{"cmd": cmd}, 1<<20)
	shell := entry.Shell
	if shell == nil || shell.ExitCode != 128 {
		t.Fatalf("shell = %+v", shell)
	}
	if !strings.HasSuffix(shell.Stderr, "\nfatal: the end") || len([]rune(shell.Stderr)) != consoleActivityOutputMaxChars {
		t.Fatalf("stderr kept %d characters ending %q", len([]rune(shell.Stderr)), shell.Stderr[len(shell.Stderr)-20:])
	}
	if shell.StderrOmitted != extra+len("\nfatal: the end") || shell.StderrTruncated {
		t.Fatalf("stderr omitted = %d truncated = %v", shell.StderrOmitted, shell.StderrTruncated)
	}

	// The tool's own capture limit is reported, not hidden.
	entry = runConsoleShellCall(t, sink, hub, "capped", map[string]any{"cmd": "printf 'abcdefghij'; printf 'fatal: x' >&2; exit 2"}, 4)
	want := consoleShellResult{ExitCode: 2, Stdout: "abcd", Stderr: "fata", StdoutTruncated: true, StderrTruncated: true}
	if entry.Shell == nil || *entry.Shell != want {
		t.Fatalf("shell = %+v, want %+v", entry.Shell, want)
	}

	// A timeout says so: its reason is more than the exit code.
	entry = runConsoleShellCall(t, sink, hub, "slow", map[string]any{"cmd": "printf started; sleep 5", "timeout_seconds": 0.2}, 4096)
	if entry.Shell == nil || entry.Shell.ExitCode != 124 || entry.Shell.Stdout != "started" || !strings.Contains(entry.Shell.Reason, "timed out") {
		t.Fatalf("timed out shell = %+v", entry.Shell)
	}
}

func TestConsoleShellDiagnosticsAreRedactedUnderGuard(t *testing.T) {
	const secret = "Bearer abcdefghijklmnopqrstuvwxyz0123"
	cmd := "curl -H 'Authorization: " + secret + "' https://example.invalid; printf 'denied for " + secret + "\\n' >&2; exit 22"
	for _, guarded := range []bool{false, true} {
		sink, hub := newConsoleShellSink(guarded)
		entry := runConsoleShellCall(t, sink, hub, "c", map[string]any{"cmd": cmd}, 4096)
		sink.Close()
		if entry.Shell == nil || entry.Shell.ExitCode != 22 {
			t.Fatalf("guarded=%v: shell = %+v", guarded, entry.Shell)
		}
		raw, _ := json.Marshal(entry)
		if leaked := strings.Contains(string(raw), "abcdefghijklmnopqrstuvwxyz0123"); leaked == guarded {
			t.Fatalf("guarded=%v: secret shown = %v in %s", guarded, leaked, raw)
		}
		if !strings.Contains(entry.Shell.Stderr, "denied for") {
			t.Fatalf("guarded=%v: stderr = %q", guarded, entry.Shell.Stderr)
		}
	}
}

func TestConsoleShellDiagnosticsInCodeModeCall(t *testing.T) {
	var progress *consoleActivityProgress
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{Kind: agent.EventKindToolStart, ActivityID: "cm", ToolName: "codemode", Status: "running"})
	tool := builtin.NewBashTool(true, 5*time.Second, 4096, pathroots.PathRoots{})
	observation, err := tool.Execute(context.Background(), map[string]any{"cmd": "printf 'fatal: no remote\\n' >&2; exit 128"})
	progress, _ = updateConsoleActivityProgress(progress, agent.Event{
		Kind: agent.EventKindToolDone, ActivityID: "cm.0", ParentActivityID: "cm", ToolName: "bash", Status: "failed", Text: observation, Error: err.Error(),
	})
	child := progress.History[0].Children[0]
	if child.Shell == nil || child.Shell.Stderr != "fatal: no remote\n" || child.Shell.ExitCode != 128 {
		t.Fatalf("codemode call shell = %+v", child.Shell)
	}
}

func itoa(n int) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}
