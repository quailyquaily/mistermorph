package builtin

import (
	"context"
	"github.com/quailyquaily/mistermorph/agent"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestExecuteShellCommandReturnsObservationOnExitError(t *testing.T) {
	out, err := executeShellCommand(context.Background(), map[string]any{
		"cmd": "printf 'boom'; exit 7",
	}, shellToolCommon{
		ToolName:       "powershell",
		DefaultTimeout: 5 * time.Second,
		MaxOutputBytes: 4096,
	}, shellRunnerSpec{
		Program:         "bash",
		ArgsPrefix:      []string{"-lc"},
		MatchDeniedPath: bashCommandDenied,
	})
	if err == nil {
		t.Fatalf("expected error, got nil (out=%q)", out)
	}
	if !strings.Contains(err.Error(), "powershell exited with code 7") {
		t.Fatalf("error = %v, want powershell exited with code 7", err)
	}
	if !strings.Contains(out, "exit_code: 7") {
		t.Fatalf("expected observation to contain exit_code: 7, got %q", out)
	}
	if !strings.Contains(out, "boom") {
		t.Fatalf("expected observation to contain stdout payload, got %q", out)
	}
}

func TestExecuteShellCommandDropsObservationOnTimeoutByDefault(t *testing.T) {
	out, err := executeShellCommand(context.Background(), map[string]any{
		"cmd":             "sleep 1",
		"timeout_seconds": 0.05,
	}, shellToolCommon{
		ToolName:       "powershell",
		DefaultTimeout: 5 * time.Second,
		MaxOutputBytes: 4096,
	}, shellRunnerSpec{
		Program:         "bash",
		ArgsPrefix:      []string{"-lc"},
		MatchDeniedPath: bashCommandDenied,
	})
	if err == nil {
		t.Fatalf("expected timeout error, got nil (out=%q)", out)
	}
	if !strings.Contains(err.Error(), "powershell timed out after") {
		t.Fatalf("error = %v, want powershell timed out after", err)
	}
	if out != "" {
		t.Fatalf("expected timeout path to drop observation, got %q", out)
	}
}

func TestShellReportsActualWorkerPIDAfterStart(t *testing.T) {
	for _, failStart := range []bool{false, true} {
		t.Run(strconv.FormatBool(failStart), func(t *testing.T) {
			var events []agent.Event
			ctx := agent.WithEventSinkContext(context.Background(), agent.EventSinkFunc(func(_ context.Context, event agent.Event) {
				if event.Kind == agent.EventKindWorkerProcess {
					events = append(events, event)
				}
			}))
			_, ctx, _ = agent.PrepareSubtaskContext(ctx, nil)
			program := "bash"
			if failStart {
				program = filepath.Join(t.TempDir(), "missing-shell")
			}
			hookPID := 0
			payload, _, err := runShellCommand(ctx, shellToolCommon{ToolName: "bash", MaxOutputBytes: 1024}, shellRunnerSpec{
				Program: program, ArgsPrefix: []string{"-c"}, OnStart: func(pid int) { hookPID = pid },
			}, shellInvocation{Command: "printf '%s' \"$$\"", Timeout: time.Second})
			if failStart {
				if err == nil || hookPID != 0 || len(events) != 0 {
					t.Fatalf("failed start reported PID: %+v", events)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			pid, err := strconv.Atoi(payload.Stdout)
			if err != nil {
				t.Fatal(err)
			}
			if len(events) != 1 || events[0].Worker.Processes[0].PID != pid || hookPID != pid {
				t.Fatalf("PID %d, hook %d, events %+v", pid, hookPID, events)
			}
		})
	}
}
