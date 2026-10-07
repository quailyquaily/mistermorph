//go:build !windows

package processrestart

import (
	"os"
	"syscall"
)

// Exec replaces the running program with a fresh start of the same binary, arguments and
// environment. It returns only on failure.
func Exec() error {
	path, err := executable()
	if err != nil {
		return err
	}
	return syscall.Exec(path, os.Args, os.Environ())
}
