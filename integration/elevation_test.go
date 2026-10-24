package integration

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/elevate"
)

// TestRunAskpassIfRequestedHelperProcess is the program sudo starts as the askpass helper: the
// test below runs this test binary again with the askpass environment.
func TestRunAskpassIfRequestedHelperProcess(t *testing.T) {
	if os.Getenv("INTEGRATION_ASKPASS_HELPER") != "1" {
		t.Skip("run by TestRunAskpassIfRequested")
	}
	RunAskpassIfRequested()
	t.Fatal("RunAskpassIfRequested returned in askpass mode")
}

func TestRunAskpassIfRequested(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the askpass helper serves sudo on Linux and macOS")
	}
	dialog := filepath.Join(t.TempDir(), "zenity")
	if err := os.WriteFile(dialog, []byte("#!/bin/sh\nprintf 'hunter2\\n'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestRunAskpassIfRequestedHelperProcess$")
	cmd.Env = append(os.Environ(),
		"INTEGRATION_ASKPASS_HELPER=1",
		elevate.EnvAskpass+"=1",
		elevate.EnvCommand+"=apt-get install -y jq",
		elevate.EnvDialog+"="+dialog,
	)
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("helper process: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "hunter2" {
		t.Fatalf("helper printed %q, want the password the dialog returned", got)
	}

	// Not started by sudo: it returns, and elevated commands may use this executable from now on.
	RunAskpassIfRequested()
}
