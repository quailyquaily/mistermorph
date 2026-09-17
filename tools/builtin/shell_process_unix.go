//go:build unix

package builtin

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configureShellProcess(cmd *exec.Cmd) {
	// Tools must not share the chat terminal. Redirecting stdin alone does not
	// prevent commands such as psql from opening /dev/tty for a password prompt.
	// A new session also gives the shell and its pipeline a separate group.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Cancel = func() error {
		// CommandContext otherwise kills only the shell, leaving its children
		// running after a timeout or task cancellation.
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
