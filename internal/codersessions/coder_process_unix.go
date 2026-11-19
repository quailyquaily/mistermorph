//go:build unix

package codersessions

import (
	"errors"
	"os/exec"
	"syscall"
)

func configureCoderProcess(cmd *exec.Cmd) {
	// A new session keeps the CLI off the chat terminal and puts every process it
	// starts in one group, so stopping it reaches the commands it runs too.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// killGroup kills the process group pgid (a coder process's, led by it). Only rpc calls it,
// while the process is not reaped. Replaced in tests.
var killGroup = func(pgid int) error {
	err := syscall.Kill(-pgid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
