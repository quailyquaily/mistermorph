//go:build !unix

package codersessions

import "os/exec"

// Keep CommandContext's default cancellation on platforms without Unix sessions.
func configureCoderProcess(cmd *exec.Cmd) {}
