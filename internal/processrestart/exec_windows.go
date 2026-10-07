//go:build windows

package processrestart

import (
	"os"
	"os/exec"
)

// Exec starts a new copy of the process with the same arguments, environment, working directory
// and standard streams; the caller then exits.
func Exec() error {
	path, err := executable()
	if err != nil {
		return err
	}
	cmd := exec.Command(path, os.Args[1:]...)
	cmd.Env = os.Environ()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if dir, err := os.Getwd(); err == nil {
		cmd.Dir = dir
	}
	return cmd.Start()
}
