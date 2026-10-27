//go:build linux

package elevate

import (
	"fmt"
	"net"
	"os"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

// peerProcess is the pid and user of the process at the other end of conn.
func peerProcess(conn *net.UnixConn) (pid, uid int, err error) {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0, 0, err
	}
	var cred *unix.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return 0, 0, err
	}
	if credErr != nil {
		return 0, 0, credErr
	}
	return int(cred.Pid), int(cred.Uid), nil
}

// parentProcess is pid's parent, from /proc/<pid>/stat.
func parentProcess(pid int) (int, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return 0, err
	}
	// "pid (comm) state ppid ...": comm may hold spaces and parentheses, so read after the last ")".
	stat := string(raw)
	end := strings.LastIndexByte(stat, ')')
	if end < 0 {
		return 0, fmt.Errorf("unreadable /proc/%d/stat", pid)
	}
	fields := strings.Fields(stat[end+1:])
	if len(fields) < 2 {
		return 0, fmt.Errorf("unreadable /proc/%d/stat", pid)
	}
	return strconv.Atoi(fields[1])
}
