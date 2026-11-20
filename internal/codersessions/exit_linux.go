package codersessions

import (
	"errors"

	"golang.org/x/sys/unix"
)

// exitWatch blocks until pid, a child of this process, has exited, and leaves it unreaped: until
// it is reaped, its pid (and its group's id) stays its own. false says the exit could not be
// watched: then the process may still run.
func exitWatch(pid int) bool {
	var info unix.Siginfo
	for {
		err := unix.Waitid(unix.P_PID, pid, &info, unix.WEXITED|unix.WNOWAIT, nil)
		if err == nil {
			return true
		}
		if !errors.Is(err, unix.EINTR) {
			return false
		}
	}
}
