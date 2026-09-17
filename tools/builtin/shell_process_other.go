//go:build !unix

package builtin

import "os/exec"

// Keep CommandContext's default cancellation on platforms without Unix sessions.
func configureShellProcess(cmd *exec.Cmd) {}
