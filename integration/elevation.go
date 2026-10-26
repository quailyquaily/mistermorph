package integration

import "github.com/quailyquaily/mistermorph/internal/elevate"

// RunAskpassIfRequested lets the program's agent run elevated commands on Linux and macOS
// (tools.bash.elevation, off by default in embedded programs). Call it first thing in main, before
// parsing flags or starting anything.
//
// An elevated command runs under `sudo -A`, and sudo starts the running executable, your program,
// as its askpass helper. When this process is that helper, RunAskpassIfRequested gets the password
// from the agent that started the command (which asked the user in a dialog), prints it for sudo
// and exits. Otherwise it returns at once. Until it has run, elevated commands are unavailable on
// Linux and macOS even with tools.bash.elevation.enabled set.
// Windows elevates through UAC and does not need it, and neither does a program that names its own
// askpass program in tools.bash.elevation.askpass: sudo starts that program instead.
func RunAskpassIfRequested() {
	elevate.HandleAskpass()
}

// The contract between an elevated bash command and an askpass program of the program's own
// (tools.bash.elevation.askpass). sudo runs that program with its prompt as the only argument; it
// prints the password on stdout and exits 0, or exits non-zero when the user does not approve. These
// names and lines are stable.
const (
	// ElevateCommandEnv holds the command the user is asked to approve, for the dialog to show.
	ElevateCommandEnv = elevate.EnvCommand
	// ElevateDeadlineEnv holds when to give up waiting for the user, in Unix seconds.
	ElevateDeadlineEnv = elevate.EnvDeadline
	// ElevateDeclinedMarker is the line the program writes to stderr when the user cancels, so the
	// agent is told the user declined rather than that the command failed.
	ElevateDeclinedMarker = elevate.DeclinedMarker
	// ElevateTimedOutMarker is the line it writes to stderr when nobody answered by the deadline.
	ElevateTimedOutMarker = elevate.TimedOutMarker
)
