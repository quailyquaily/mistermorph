//go:build linux

package builtin

import (
	"context"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/quailyquaily/mistermorph/internal/pathroots"
	"github.com/quailyquaily/mistermorph/internal/proctrack"
)

// What a bash command leaves running is stopped when its run ends, unless the call asked to keep
// it running (keep_running).
func TestBashLeftoversAreStoppedWhenTheRunEnds(t *testing.T) {
	tool := NewBashTool(true, 5*time.Second, 4096, pathroots.PathRoots{})
	ctx, owner := proctrack.Default.Begin(context.Background())
	proctrack.Attach(ctx, "bash-leftover-"+strconv.Itoa(os.Getpid()))

	start := func(keep bool) int {
		pidFile := filepath.Join(t.TempDir(), "pid")
		cmd := "nohup bash -c 'echo $$ > " + pidFile + "; while :; do sleep 1; done' >/dev/null 2>&1 &"
		if _, err := tool.Execute(ctx, map[string]any{"cmd": cmd, "keep_running": keep}); err != nil {
			t.Fatal(err)
		}
		for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(20 * time.Millisecond) {
			if b, err := os.ReadFile(pidFile); err == nil && strings.TrimSpace(string(b)) != "" {
				pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
				return pid
			}
		}
		t.Fatal("the loop did not start")
		return 0
	}
	left := start(false)
	kept := start(true)
	t.Cleanup(func() {
		_ = syscall.Kill(left, syscall.SIGKILL)
		_ = syscall.Kill(kept, syscall.SIGKILL)
	})
	if !running(left) {
		t.Fatal("the loop should outlive its command")
	}

	owner.End(false)
	if running(left) {
		t.Fatalf("the loop %d survived the end of the run", left)
	}
	if !running(kept) {
		t.Fatalf("the kept loop %d was stopped", kept)
	}
}

func running(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	s := string(b)
	fields := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
	return len(fields) > 0 && fields[0] != "Z"
}
