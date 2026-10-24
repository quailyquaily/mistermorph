package builtin

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"strings"

	"github.com/quailyquaily/mistermorph/internal/elevate"
)

// runElevated runs an elevated shell command (spec already wraps it in sudo or the UAC script) and
// tells a declined or unanswered approval apart from a failed command. Each run is logged with its
// command and outcome; the password never reaches this process. command is what the user asked
// to run, for the log: inv.Command may be a wrapper script.
func runElevated(ctx context.Context, toolName, command string, common shellToolCommon, spec shellRunnerSpec, inv shellInvocation) (string, error) {
	logger := slog.Default()
	logger.Info("elevated_command_started", "tool", toolName, "command", command, "cwd", inv.CWD)
	payload, _, runErr := runShellCommand(ctx, common, spec, inv)
	output := payload.Stderr + "\n" + payload.Stdout
	declined := strings.Contains(output, elevate.DeclinedMarker)
	timedOut := strings.Contains(output, elevate.TimedOutMarker)
	logger.Info("elevated_command_finished",
		"tool", toolName,
		"command", command,
		"exit_code", payload.ExitCode,
		"declined", declined,
		"timed_out", timedOut,
	)
	observation := formatShellObservation(payload)
	switch {
	case declined:
		return observation, fmt.Errorf("the user declined administrator approval, so the command did not run; do not run it again unless the user asks")
	case timedOut:
		return observation, fmt.Errorf("nobody answered the administrator approval dialog in time, so the command did not run")
	}
	return observation, runErr
}

// sudoNoTerminal matches sudo (or sudo-rs) failing because it could not ask for a password: shell
// commands run without a terminal.
var sudoNoTerminal = regexp.MustCompile(`(?im)^sudo(?:-rs)?:.*(?:terminal is required|password is required|interactive authentication is required|no tty present|no askpass program)`)

func sudoWantsTerminal(output string) bool {
	return sudoNoTerminal.MatchString(output)
}
