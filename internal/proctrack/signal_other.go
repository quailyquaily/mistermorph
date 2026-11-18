//go:build !unix

package proctrack

func signalProcess(int, bool) error { return errUnsupported }
