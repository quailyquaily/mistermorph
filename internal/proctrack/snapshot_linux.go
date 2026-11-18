//go:build linux

package proctrack

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const supported = true

// clockTicks is USER_HZ, the unit of /proc/<pid>/stat's start time: 100 on every Linux ABI.
const clockTicks = 100

func bootTime() (time.Time, error) {
	f, err := os.Open("/proc/stat")
	if err != nil {
		return time.Time{}, err
	}
	defer f.Close()
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		if rest, ok := strings.CutPrefix(scan.Text(), "btime "); ok {
			secs, err := strconv.ParseInt(strings.TrimSpace(rest), 10, 64)
			if err != nil {
				return time.Time{}, err
			}
			return time.Unix(secs, 0), nil
		}
	}
	return time.Time{}, fmt.Errorf("no btime in /proc/stat")
}

// Snapshot lists the user's processes.
func Snapshot() ([]Proc, error) {
	boot, err := bootTime()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil, err
	}
	uid := uint32(os.Getuid())
	out := make([]Proc, 0, len(entries))
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil || pid <= 0 {
			continue
		}
		p, owner, err := readLinuxProc(pid, boot)
		if err != nil || owner != uid {
			continue
		}
		out = append(out, p)
	}
	return out, nil
}

func readProc(pid int) (Proc, error) {
	boot, err := bootTime()
	if err != nil {
		return Proc{}, err
	}
	p, _, err := readLinuxProc(pid, boot)
	return p, err
}

func readLinuxProc(pid int, boot time.Time) (Proc, uint32, error) {
	dir := "/proc/" + strconv.Itoa(pid)
	info, err := os.Stat(dir)
	if err != nil {
		return Proc{}, 0, err
	}
	var owner uint32
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		owner = st.Uid
	}
	stat, err := os.ReadFile(dir + "/stat")
	if err != nil {
		return Proc{}, owner, err
	}
	p, err := parseStat(pid, string(stat), boot)
	if err != nil {
		return Proc{}, owner, err
	}
	if b, err := os.ReadFile(dir + "/cmdline"); err == nil {
		p.Args = splitNUL(b)
	}
	if b, err := os.ReadFile(dir + "/environ"); err == nil {
		p.Tags = tagsFrom(splitNUL(b))
	}
	return p, owner, nil
}

// parseStat reads /proc/<pid>/stat: "pid (comm) state ppid pgrp session ... starttime ...".
// The name can hold spaces and parentheses, so the fields are counted from its last ')'.
func parseStat(pid int, stat string, boot time.Time) (Proc, error) {
	open, end := strings.IndexByte(stat, '('), strings.LastIndexByte(stat, ')')
	if open < 0 || end < open {
		return Proc{}, fmt.Errorf("bad stat for %d", pid)
	}
	fields := strings.Fields(stat[end+1:])
	// fields[0] is field 3 (state); starttime is field 22.
	if len(fields) < 20 {
		return Proc{}, fmt.Errorf("short stat for %d", pid)
	}
	ppid, _ := strconv.Atoi(fields[1])
	sid, _ := strconv.Atoi(fields[3])
	ticks, err := strconv.ParseUint(fields[19], 10, 64)
	if err != nil {
		return Proc{}, err
	}
	start := boot.Add(time.Duration(ticks) * time.Second / clockTicks)
	return Proc{PID: pid, PPID: ppid, SID: sid, Start: start, Name: stat[open+1 : end]}, nil
}
