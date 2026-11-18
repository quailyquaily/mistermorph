//go:build !linux && !darwin

package proctrack

import "errors"

const supported = false

var errUnsupported = errors.New("process tracking is not supported on this system")

// Snapshot lists the user's processes.
func Snapshot() ([]Proc, error) { return nil, errUnsupported }

func readProc(int) (Proc, error) { return Proc{}, errUnsupported }
