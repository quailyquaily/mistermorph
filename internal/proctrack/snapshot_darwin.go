//go:build darwin

package proctrack

import (
	"bytes"
	"encoding/binary"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

const supported = true

// Snapshot lists the user's processes.
func Snapshot() ([]Proc, error) {
	kinfos, err := unix.SysctlKinfoProcSlice("kern.proc.uid", os.Getuid())
	if err != nil {
		return nil, err
	}
	out := make([]Proc, 0, len(kinfos))
	for i := range kinfos {
		out = append(out, fromKinfo(&kinfos[i]))
	}
	return out, nil
}

func readProc(pid int) (Proc, error) {
	k, err := unix.SysctlKinfoProc("kern.proc.pid", pid)
	if err != nil {
		return Proc{}, err
	}
	return fromKinfo(k), nil
}

func fromKinfo(k *unix.KinfoProc) Proc {
	pid := int(k.Proc.P_pid)
	name := k.Proc.P_comm[:]
	if i := bytes.IndexByte(name, 0); i >= 0 {
		name = name[:i]
	}
	p := Proc{
		PID:   pid,
		PPID:  int(k.Eproc.Ppid),
		Start: time.Unix(k.Proc.P_starttime.Sec, int64(k.Proc.P_starttime.Usec)*1000),
		Name:  string(name),
	}
	if sid, err := unix.Getsid(pid); err == nil {
		p.SID = sid
	}
	if raw, err := unix.SysctlRaw("kern.procargs2", pid); err == nil {
		p.Args, p.Tags = parseProcargs2(raw)
	}
	return p
}

// parseProcargs2 reads KERN_PROCARGS2: argc (int32), the executable's path, NUL padding, argc
// arguments and then the environment, each NUL-terminated.
func parseProcargs2(raw []byte) (args []string, tags map[string]string) {
	if len(raw) < 4 {
		return nil, nil
	}
	argc := int(binary.LittleEndian.Uint32(raw[:4]))
	rest := raw[4:]
	// Skip the executable path and the padding after it.
	i := bytes.IndexByte(rest, 0)
	if i < 0 {
		return nil, nil
	}
	rest = rest[i:]
	for len(rest) > 0 && rest[0] == 0 {
		rest = rest[1:]
	}
	parts := bytes.Split(rest, []byte{0})
	var env []string
	for _, part := range parts {
		if len(args) < argc {
			args = append(args, string(part))
			continue
		}
		if len(part) == 0 {
			break
		}
		env = append(env, string(part))
	}
	return args, tagsFrom(env)
}
