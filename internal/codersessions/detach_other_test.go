//go:build !unix

package codersessions

import "os/exec"

func detachTestProcess(cmd *exec.Cmd) {}
