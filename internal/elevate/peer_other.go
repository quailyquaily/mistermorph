//go:build !linux && !darwin

package elevate

import (
	"errors"
	"net"
)

var errPeerUnsupported = errors.New("checking the askpass helper is supported on Linux and macOS only")

func peerProcess(*net.UnixConn) (pid, uid int, err error) { return 0, 0, errPeerUnsupported }

func parentProcess(int) (int, error) { return 0, errPeerUnsupported }
