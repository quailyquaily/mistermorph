//go:build darwin || dragonfly || freebsd || netbsd || openbsd

package codersessions

import (
	"errors"
	"syscall"
)

// exitWatch blocks until pid, a child of this process, has exited, and leaves it unreaped: until
// it is reaped, its pid (and its group's id) stays its own. false says the exit could not be
// watched: then the process may still run.
func exitWatch(pid int) bool {
	kq, err := syscall.Kqueue()
	if err != nil {
		return false
	}
	defer syscall.Close(kq)
	var change syscall.Kevent_t
	syscall.SetKevent(&change, pid, syscall.EVFILT_PROC, syscall.EV_ADD|syscall.EV_ONESHOT)
	change.Fflags = syscall.NOTE_EXIT
	for {
		_, err = syscall.Kevent(kq, []syscall.Kevent_t{change}, nil, nil)
		if !errors.Is(err, syscall.EINTR) {
			break
		}
	}
	if errors.Is(err, syscall.ESRCH) {
		// Only the watcher reaps the process: it is gone from the process table's live entries
		// because it exited, and is a zombie still.
		return true
	}
	if err != nil {
		return false
	}
	events := make([]syscall.Kevent_t, 1)
	for {
		n, err := syscall.Kevent(kq, nil, events, nil)
		if errors.Is(err, syscall.EINTR) || (err == nil && n == 0) {
			continue
		}
		return err == nil && (events[0].Flags&syscall.EV_ERROR == 0 || syscall.Errno(events[0].Data) == syscall.ESRCH)
	}
}
