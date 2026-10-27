package integration

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

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
	approver := elevate.ApproverFunc(func(context.Context, elevate.Request) (string, error) { return "hunter2", nil })
	deadline := time.Now().Add(time.Minute)
	session, err := elevate.Begin(elevate.WithApprover(context.Background(), approver), elevate.Config{}, "apt-get install -y jq", "/", deadline)
	if err != nil {
		t.Fatal(err)
	}
	defer session.End()
	cmd := exec.Command(os.Args[0], "-test.run=^TestRunAskpassIfRequestedHelperProcess$")
	cmd.Env = append(os.Environ(),
		"INTEGRATION_ASKPASS_HELPER=1",
		elevate.EnvAskpass+"=1",
		elevate.EnvCommand+"=apt-get install -y jq",
		elevate.EnvDeadline+"="+strconv.FormatInt(deadline.Unix(), 10),
	)
	cmd.Env = append(cmd.Env, session.Env()...)
	// This process plays sudo: the helper is its child.
	session.Started(os.Getpid())
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("helper process: %v", err)
	}
	if got := strings.TrimSpace(string(out)); got != "hunter2" {
		t.Fatalf("helper printed %q, want the password the approver returned", got)
	}

	// Not started by sudo: it returns, and elevated commands may use this executable from now on.
	RunAskpassIfRequested()
}

// An embedding program's bash offers elevated commands once it has called RunAskpassIfRequested
// and turned tools.bash.elevation on; by default it does not.
func TestEmbeddedBashOffersElevationWhenTurnedOn(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the desktop session and dialog set up here are Linux's")
	}
	// A desktop session with sudo and a dialog program, whatever machine runs the test.
	bin := t.TempDir()
	for _, name := range []string{"sudo", "zenity"} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Setenv("WAYLAND_DISPLAY", "wayland-test")
	RunAskpassIfRequested()

	cases := []struct {
		name    string
		enabled *bool
		want    bool
	}{
		{name: "default", want: false},
		{name: "turned on", enabled: boolPtr(true), want: true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := DefaultConfig()
			cfg.Features.Skills = false
			cfg.Set("file_state_dir", t.TempDir())
			cfg.Set("tools.bash.enabled", true)
			cfg.Set("tools.bash.elevation.dialog", filepath.Join(bin, "zenity"))
			if tc.enabled != nil {
				cfg.Set("tools.bash.elevation.enabled", *tc.enabled)
			}
			bash, ok := New(cfg).NewRegistry().Get("bash")
			if !ok {
				t.Fatal("bash is not registered")
			}
			if got := strings.Contains(bash.ParameterSchema(), `"elevated"`); got != tc.want {
				t.Fatalf("bash offers elevated = %v, want %v", got, tc.want)
			}
		})
	}
}

func boolPtr(v bool) *bool { return &v }

// The askpass contract is part of the API: an embedding program's askpass program depends on these
// exact names and lines, so changing one is a breaking change.
func TestElevateAskpassContractIsStable(t *testing.T) {
	cases := []struct{ name, got, want string }{
		{"command variable", ElevateCommandEnv, "MISTERMORPH_ELEVATE_COMMAND"},
		{"deadline variable", ElevateDeadlineEnv, "MISTERMORPH_ELEVATE_DEADLINE"},
		{"declined line", ElevateDeclinedMarker, "mistermorph: administrator approval was declined"},
		{"timed out line", ElevateTimedOutMarker, "mistermorph: administrator approval timed out"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.got != tc.want {
				t.Fatalf("%s = %q, want %q", tc.name, tc.got, tc.want)
			}
		})
	}
}
