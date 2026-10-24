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
