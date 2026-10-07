//go:build !windows

package processrestart

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
)

// TestExecRestartsInPlace runs this test binary as a helper that restarts itself once: the restarted
// program must keep the PID and see the same arguments.
func TestExecRestartsInPlace(t *testing.T) {
	if stage := os.Getenv("PROCESSRESTART_STAGE"); stage != "" {
		fmt.Printf("stage=%s pid=%d args=%s\n", stage, os.Getpid(), strings.Join(os.Args[1:], " "))
		if stage == "before" {
			os.Setenv("PROCESSRESTART_STAGE", "after")
			Request()
			if err := Exec(); err != nil {
				fmt.Println("exec error:", err)
				os.Exit(2)
			}
		}
		os.Exit(0)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestExecRestartsInPlace$")
	cmd.Env = append(os.Environ(), "PROCESSRESTART_STAGE=before")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("helper failed: %v\n%s", err, out)
	}
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	if len(lines) != 2 || !strings.HasPrefix(lines[0], "stage=before") || !strings.HasPrefix(lines[1], "stage=after") {
		t.Fatalf("output = %q", out)
	}
	pid := func(line string) string { return strings.Fields(line)[1] }
	args := func(line string) string { return strings.SplitN(line, "args=", 2)[1] }
	if pid(lines[0]) != pid(lines[1]) || args(lines[0]) != args(lines[1]) {
		t.Fatalf("restart changed the process: %q", lines)
	}
}

func TestExecutableStripsDeletedSuffix(t *testing.T) {
	path, err := executable()
	if err != nil || strings.HasSuffix(path, " (deleted)") || path == "" {
		t.Fatalf("executable() = %q, %v", path, err)
	}
}
