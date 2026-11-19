//go:build !unix

package codersessions

import "os/exec"

// Without Unix sessions a coder process has no group of its own: only the process is stopped
// (exitWatch is not supported here, so rpc stops it through its handle).
func configureCoderProcess(cmd *exec.Cmd) {}

var killGroup = func(pgid int) error { return nil }
