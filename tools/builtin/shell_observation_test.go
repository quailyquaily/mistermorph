package builtin

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

func TestParseShellObservation(t *testing.T) {
	cases := []struct {
		name    string
		payload shellExecutionPayload
		suffix  string
	}{
		{name: "stderr and exit 128", payload: shellExecutionPayload{ExitCode: 128, Stderr: "fatal: not a git repository (or any of the parent directories): .git\n"}},
		{name: "stdout only", payload: shellExecutionPayload{ExitCode: 1, Stdout: "FAIL ./pkg\n"}},
		{name: "empty", payload: shellExecutionPayload{ExitCode: 2}},
		{name: "truncated", payload: shellExecutionPayload{ExitCode: 1, Stdout: "a", Stderr: "b", StdoutTruncated: true, StderrTruncated: true}},
		{name: "stdout holds the stderr heading", payload: shellExecutionPayload{ExitCode: 3, Stdout: "x\n\nstderr:\ny", Stderr: "real"}},
		{name: "multiline with blank lines", payload: shellExecutionPayload{ExitCode: 1, Stdout: "\n\nline\n\n", Stderr: "\n"}},
		{name: "elevation hint", payload: shellExecutionPayload{ExitCode: 1, Stderr: "sudo: a terminal is required"}, suffix: "\n\n" + sudoElevationHint},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := ParseShellObservation(formatShellObservation(tc.payload) + tc.suffix)
			if !ok {
				t.Fatal("ParseShellObservation() ok = false")
			}
			if want := shellResultFromPayload(tc.payload); got != want {
				t.Fatalf("ParseShellObservation() = %#v, want %#v", got, want)
			}
		})
	}

	for _, text := range []string{"", "Error: blocked by guard (tool output)", "exit_code: x\n", "exit_code: 1\nstdout_truncated: false\n"} {
		if _, ok := ParseShellObservation(text); ok {
			t.Fatalf("ParseShellObservation(%q) ok = true, want false", text)
		}
	}
}

func TestParseShellObservationReadsBashSubtaskEnvelope(t *testing.T) {
	tool := NewBashTool(true, 5*time.Second, 4096, pathroots.PathRoots{})
	out, err := tool.Execute(context.Background(), map[string]any{
		"cmd":            "printf 'fatal: bad object HEAD\\n' >&2; exit 128",
		"run_in_subtask": true,
	})
	if err == nil {
		t.Fatalf("Execute() error = nil, want exit error (out=%q)", out)
	}
	got, ok := ParseShellObservation(out)
	if !ok {
		t.Fatalf("ParseShellObservation(%q) ok = false", out)
	}
	if got.ExitCode != 128 || got.Stderr != "fatal: bad object HEAD\n" || got.Stdout != "" {
		t.Fatalf("ParseShellObservation() = %#v", got)
	}
	if _, ok := ParseShellObservation(`{"status":"done","output_schema":"subtask.other.v1","output":{"exit_code":1}}`); ok {
		t.Fatal("another subtask's result read as a shell result")
	}
}

func TestParseShellObservationReadsBashFailure(t *testing.T) {
	tool := NewBashTool(true, 5*time.Second, 8, pathroots.PathRoots{})
	out, err := tool.Execute(context.Background(), map[string]any{"cmd": "printf 'only stdout here'; exit 1"})
	if err == nil || !strings.Contains(err.Error(), "exited with code 1") {
		t.Fatalf("Execute() error = %v", err)
	}
	got, ok := ParseShellObservation(out)
	if !ok {
		t.Fatalf("ParseShellObservation(%q) ok = false", out)
	}
	// The tool's capture limit (8 bytes) cut stdout; the result says so.
	want := ShellResult{ExitCode: 1, Stdout: "only std", StdoutTruncated: true}
	if got != want {
		t.Fatalf("ParseShellObservation() = %#v, want %#v", got, want)
	}
}
