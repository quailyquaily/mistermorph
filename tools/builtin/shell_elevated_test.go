package builtin

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/quailyquaily/mistermorph/internal/elevate"
	"github.com/quailyquaily/mistermorph/internal/pathroots"
)

// TestMain lets the test binary stand in for mistermorph as sudo's askpass helper: an elevated
// command sets SUDO_ASKPASS to the running binary, which is this one under go test.
func TestMain(m *testing.M) {
	elevate.HandleAskpass()
	os.Exit(m.Run())
}

// fakeSudo puts a sudo on PATH that asks the askpass helper for the password the way sudo -A does,
// and runs the command after "--" when it is right. It records its arguments and the environment
// the helper got.
func fakeSudo(t *testing.T) (logPath string) {
	t.Helper()
	dir := t.TempDir()
	logPath = filepath.Join(dir, "sudo.log")
	script := `#!/bin/sh
printf 'args:' >> ` + logPath + `
for a in "$@"; do printf ' [%s]' "$a" >> ` + logPath + `; done
printf '\nshown: %s\ndisplay: %s\n' "$MISTERMORPH_ELEVATE_COMMAND" "$WAYLAND_DISPLAY" >> ` + logPath + `
while [ "$1" != "--" ]; do shift; done
shift
password=$("$SUDO_ASKPASS" "[sudo] password:") || { echo "sudo: no password was provided" >&2; exit 1; }
[ "$password" = "hunter2" ] || { echo "sudo: 1 incorrect password attempt" >&2; exit 1; }
exec "$@"
`
	if err := os.WriteFile(filepath.Join(dir, "sudo"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return logPath
}

// fakeZenity is the approval dialog: it "types" answer, or cancels when answer is empty.
func fakeZenity(t *testing.T, answer string) string {
	t.Helper()
	body := "#!/bin/sh\nexit 1\n"
	if answer != "" {
		body = "#!/bin/sh\nprintf '%s\\n' '" + answer + "'\n"
	}
	path := filepath.Join(t.TempDir(), "zenity")
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

func newElevatingBashTool(t *testing.T, dialog string) *BashTool {
	t.Helper()
	tool := NewBashTool(true, 0, 0, pathroots.PathRoots{})
	tool.Elevation = elevate.Config{Enabled: true, Dialog: dialog}
	return tool
}

func TestBashElevatedCommand(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash elevates through sudo on Linux and macOS")
	}
	cases := []struct {
		name       string
		answer     string
		wantErr    string
		wantOutput string
	}{
		{name: "approved", answer: "hunter2", wantOutput: "installed jq"},
		{name: "declined", answer: "", wantErr: "declined administrator approval"},
		{name: "wrong password", answer: "letmein", wantErr: "exited with code 1"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("WAYLAND_DISPLAY", "wayland-test")
			t.Setenv("DISPLAY", "")
			logPath := fakeSudo(t)
			tool := newElevatingBashTool(t, fakeZenity(t, tc.answer))
			if !strings.Contains(tool.ParameterSchema(), `"elevated"`) {
				t.Fatal("the schema does not offer elevated")
			}
			out, err := tool.Execute(context.Background(), map[string]any{"cmd": "echo installed jq", "elevated": true})
			if tc.wantErr == "" && err != nil {
				t.Fatalf("Execute() error = %v\n%s", err, out)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("Execute() error = %v, want %q\n%s", err, tc.wantErr, out)
			}
			if !strings.Contains(out, tc.wantOutput) {
				t.Fatalf("output lacks %q:\n%s", tc.wantOutput, out)
			}
			if strings.Contains(out, tc.answer) && tc.answer != "" {
				t.Fatal("the password reached the tool output")
			}
			log, _ := os.ReadFile(logPath)
			for _, want := range []string{"args: [-k] [-A] [-p] [] [--] [bash] [-c] [echo installed jq]", "shown: echo installed jq", "display: wayland-test"} {
				if !strings.Contains(string(log), want) {
					t.Errorf("sudo log lacks %q:\n%s", want, log)
				}
			}
		})
	}
}

func TestBashElevationUnavailable(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash elevates through sudo on Linux and macOS")
	}
	cases := []struct {
		name    string
		enabled bool
		display string
		wantErr string
	}{
		{name: "turned off", enabled: false, display: "wayland-test", wantErr: "turned off"},
		{name: "no desktop", enabled: true, display: "", wantErr: "no desktop session"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if runtime.GOOS != "linux" && tc.display == "" {
				t.Skip("only Linux needs a display variable")
			}
			t.Setenv("WAYLAND_DISPLAY", tc.display)
			t.Setenv("DISPLAY", "")
			fakeSudo(t)
			tool := newElevatingBashTool(t, fakeZenity(t, "hunter2"))
			tool.Elevation.Enabled = tc.enabled
			if strings.Contains(tool.ParameterSchema(), `"elevated"`) {
				t.Fatal("the schema offers elevated where it cannot work")
			}
			_, err := tool.Execute(context.Background(), map[string]any{"cmd": "systemctl restart nginx", "elevated": true})
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) || !strings.Contains(err.Error(), "run the command themselves: systemctl restart nginx") {
				t.Fatalf("Execute() error = %v", err)
			}
		})
	}
}

func TestBashSuggestsElevationWhenSudoNeedsATerminal(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("bash elevates through sudo on Linux and macOS")
	}
	t.Setenv("WAYLAND_DISPLAY", "wayland-test")
	fakeSudo(t)
	cases := []struct {
		name     string
		enabled  bool
		stderr   string
		wantHint bool
	}{
		{name: "sudo-rs", enabled: true, stderr: "sudo: A terminal is required to authenticate", wantHint: true},
		{name: "classic sudo", enabled: true, stderr: "sudo: a terminal is required to read the password; either use the -S option", wantHint: true},
		{name: "other failure", enabled: true, stderr: "cp: cannot create regular file: Permission denied", wantHint: false},
		{name: "elevation off", enabled: false, stderr: "sudo: A terminal is required to authenticate", wantHint: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			tool := newElevatingBashTool(t, fakeZenity(t, "hunter2"))
			tool.Elevation.Enabled = tc.enabled
			out, err := tool.Execute(context.Background(), map[string]any{"cmd": "echo '" + tc.stderr + "' >&2; exit 1"})
			if err == nil {
				t.Fatal("Execute() error = nil, want the command's failure")
			}
			if got := strings.Contains(out, "elevated: true"); got != tc.wantHint {
				t.Fatalf("hint shown = %v, want %v:\n%s", got, tc.wantHint, out)
			}
		})
	}
}

func TestPowerShellOffersElevationOnWindowsOnly(t *testing.T) {
	tool := NewPowerShellTool(true, 0, 0, pathroots.PathRoots{})
	tool.Elevation = elevate.Config{Enabled: true}
	offered := strings.Contains(tool.ParameterSchema(), `"elevated"`)
	if offered != (runtime.GOOS == "windows") {
		t.Fatalf("powershell offers elevated = %v on %s", offered, runtime.GOOS)
	}
	if runtime.GOOS != "windows" {
		_, err := tool.Execute(context.Background(), map[string]any{"cmd": "Restart-Service Spooler", "elevated": true})
		if err == nil || !strings.Contains(err.Error(), "use the bash tool") {
			t.Fatalf("Execute() error = %v", err)
		}
	}
}
