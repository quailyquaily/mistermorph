//go:build unix

package agent

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRunCoderCLICancelKillsBackgroundProcesses(t *testing.T) {
	binDir, workDir := t.TempDir(), t.TempDir()
	pidFile := filepath.Join(workDir, "child.pid")
	writeFakeCoderExecutable(t, binDir, "codex", "sleep 30 &\necho $! > '"+pidFile+"'\nexec sleep 30\n")
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()

	_, err := runCoderCLI(ctx, CoderRequest{Backend: coderBackendCodex, Task: "x", CWD: workDir, LogRoot: t.TempDir(), PathExtra: []string{binDir}}, nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("runCoderCLI() error = %v, want context deadline exceeded", err)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatalf("ReadFile(pid) error = %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatalf("pid %q: %v", raw, err)
	}
	// The killed child may linger briefly as a zombie until init reaps it.
	deadline := time.Now().Add(3 * time.Second)
	for syscall.Kill(pid, 0) == nil {
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("background process %d survived cancellation", pid)
		}
		time.Sleep(20 * time.Millisecond)
	}
}
