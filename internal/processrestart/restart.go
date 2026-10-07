// Package processrestart restarts the process with the arguments, environment and working directory
// it started with. A server asks for a restart with Request and then shuts down as it would on
// SIGTERM; once everything is closed, main calls Exec.
//
// On Unix, Exec replaces the program in the same process (execve), so the PID stays the same and a
// supervisor such as systemd, launchd or the desktop app keeps tracking it. Windows cannot do that:
// Exec starts a new copy and the caller exits.
package processrestart

import (
	"os"
	"strings"
	"sync/atomic"
)

var requested atomic.Bool

// Request marks the process for a restart when it exits.
func Request() { requested.Store(true) }

// Requested reports whether a restart was requested.
func Requested() bool { return requested.Load() }

// executable is the binary to start: the one at the path the process was started from, which is a
// newer build when it was replaced while running.
func executable() (string, error) {
	path, err := os.Executable()
	if err != nil {
		return "", err
	}
	// Linux reports a binary replaced on disk as "<path> (deleted)"; start the new one at that path.
	return strings.TrimSuffix(path, " (deleted)"), nil
}
