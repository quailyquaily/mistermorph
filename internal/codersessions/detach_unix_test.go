//go:build unix

package codersessions

import (
	"os/exec"
	"syscall"
)

// detachTestProcess starts cmd in a session of its own, out of its parent's process group.
func detachTestProcess(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
