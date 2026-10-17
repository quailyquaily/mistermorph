//go:build unix

package agent

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func configureCoderProcess(cmd *exec.Cmd) {
	// A new session keeps the CLI off the chat terminal and puts every process it
	// starts in one group, so cancellation reaches the commands it runs too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
}
