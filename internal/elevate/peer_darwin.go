//go:build darwin

package elevate

import (
	"net"

	"golang.org/x/sys/unix"
)

// peerProcess is the pid and user of the process at the other end of conn.
func peerProcess(conn *net.UnixConn) (pid, uid int, err error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var cred *unix.Xucred
	var credErr, pidErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptXucred(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERCRED)
		pid, pidErr = unix.GetsockoptInt(int(fd), unix.SOL_LOCAL, unix.LOCAL_PEERPID)
	}); err != nil {
		return 0, 0, err
	}
	if credErr != nil {
		return 0, 0, credErr
	}
	if pidErr != nil {
		return 0, 0, pidErr
	}
	return pid, int(cred.Uid), nil
}

// parentProcess is pid's parent, from the kernel's process table.
func parentProcess(pid int) (int, error) {
	info, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return 0, err
	}
	return int(info.Eproc.Ppid), nil
}
