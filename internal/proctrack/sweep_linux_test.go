//go:build linux

package proctrack

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A command that leaves a loop running behind it (re-parented, in a session of its own) is
// stopped when the run ends; one started with keep_running is not.
func TestSweepStopsWhatACommandLeftRunning(t *testing.T) {
	g := NewRegistry(4)
	g.grace = 500 * time.Millisecond
	ctx, owner := g.Begin(context.Background())
	Attach(ctx, "run-"+strconv.Itoa(os.Getpid()))

	start := func(activity string, keep bool) int {
		dir := t.TempDir()
		pidFile := dir + "/pid"
		// setsid moves the loop out of the shell's session; only the env tag still marks it.
		cmd := exec.Command("bash", "-c", "setsid bash -c 'echo $$ > "+pidFile+"; while :; do sleep 1; done' >/dev/null 2>&1 < /dev/null &")
		cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
		cmd.Env = ShellEnv(ctx, os.Environ(), activity)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		AddRoot(ctx, Root{PID: cmd.Process.Pid, Kind: KindShell, Program: "bash", ActivityID: activity, Keep: keep})
		if err := cmd.Wait(); err != nil {
			t.Fatal(err)
		}
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if b, err := os.ReadFile(pidFile); err == nil && strings.TrimSpace(string(b)) != "" {
				pid, _ := strconv.Atoi(strings.TrimSpace(string(b)))
				return pid
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("the loop did not start")
		return 0
	}
	swept := start("call-1", false)
	kept := start("call-2", true)
	t.Cleanup(func() { _ = syscall.Kill(kept, syscall.SIGKILL) })

	tree, err := g.Tree(RunID(ctx))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(treePIDs(tree), " "+strconv.Itoa(swept)+" ") {
		t.Fatalf("the tree does not list the loop %d: %+v", swept, tree)
	}

	owner.End(false)
	if alive(swept) {
		_ = syscall.Kill(swept, syscall.SIGKILL)
		t.Fatalf("the loop %d survived the sweep", swept)
	}
	if !alive(kept) {
		t.Fatalf("the kept loop %d was stopped", kept)
	}
}

func treePIDs(tree Tree) string {
	var b strings.Builder
	b.WriteString(" ")
	var walk func(nodes []*Node)
	walk = func(nodes []*Node) {
		for _, n := range nodes {
			b.WriteString(strconv.Itoa(n.PID) + " ")
			walk(n.Children)
		}
	}
	for _, g := range tree.Groups {
		walk(g.Processes)
	}
	walk(tree.Other)
	return b.String()
}

func alive(pid int) bool {
	// A zombie still answers signal 0; read its state.
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	s := string(b)
	fields := strings.Fields(s[strings.LastIndexByte(s, ')')+1:])
	return len(fields) > 0 && fields[0] != "Z"
}
