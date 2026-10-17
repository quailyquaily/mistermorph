//go:build !unix

package agent

import "os/exec"

// Keep CommandContext's default cancellation on platforms without Unix sessions.
func configureCoderProcess(cmd *exec.Cmd) {}
