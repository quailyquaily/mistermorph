// Package elevate runs a shell command with administrator rights after the user approves it in a
// system dialog (docs/feat/feat_20261024_elevated_commands.md).
//
// On Linux and macOS the command runs under `sudo -k -A`. sudo reads the password from an askpass
// program. By default the running mistermorph binary is that program: started with
// MISTERMORPH_ASKPASS=1 it shows a dialog (pinentry, zenity or kdialog on Linux, osascript on
// macOS), prints what the user typed for sudo and exits. A program of the user's own can take its
// place (Config.Askpass); it gets the command and deadline from EnvCommand and EnvDeadline, and
// reports a declined or unanswered approval with DeclinedMarker or TimedOutMarker. The password goes from the dialog to sudo only; the agent process never
// reads it. On Windows the command runs in a powershell started with `-Verb RunAs`, which shows the
// UAC prompt (RunAsScript).
package elevate

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

// Environment variables between the shell tool, sudo and the askpass helper.
const (
	// EnvAskpass set to "1" starts the binary as sudo's askpass helper instead of the CLI.
	EnvAskpass = "MISTERMORPH_ASKPASS"
	// EnvCommand is the command the dialog names. An external askpass program gets it too.
	EnvCommand = "MISTERMORPH_ELEVATE_COMMAND"
	// EnvDialog is the dialog program chosen in config (tools.bash.elevation.dialog), if any.
	EnvDialog = "MISTERMORPH_ELEVATE_DIALOG"
	// EnvDeadline is when the dialog gives up, in Unix seconds. An external askpass program gets it
	// too, and should give up then, writing TimedOutMarker.
	EnvDeadline = "MISTERMORPH_ELEVATE_DEADLINE"
)

// DefaultApprovalTimeout is how long the dialog waits for the user, on top of the command's timeout.
const DefaultApprovalTimeout = 2 * time.Minute

// Config is a shell tool's elevation settings: tools.bash.elevation or tools.powershell.elevation.
type Config struct {
	// Key is where the settings live in config ("tools.bash.elevation"), for messages.
	Key     string
	Enabled bool
	// ApprovalTimeout is how long the dialog waits for the user.
	ApprovalTimeout time.Duration
	// Dialog names the dialog program on Linux and macOS (a pinentry, zenity or kdialog binary)
	// instead of the automatic choice.
	Dialog string
	// Askpass names an askpass program of the user's own to use instead of mistermorph's helper and
	// its dialogs (Linux, macOS): sudo runs it with the prompt as its argument, it prints the
	// password and exits 0, or exits non-zero on cancel. Dialog does not apply then.
	Askpass string
}

func (c Config) key() string {
	if key := strings.TrimSpace(c.Key); key != "" {
		return key
	}
	return "tools.bash.elevation"
}

// Approval is how long an elevated command may wait for the user.
func (c Config) Approval() time.Duration {
	if c.ApprovalTimeout > 0 {
		return c.ApprovalTimeout
	}
	return DefaultApprovalTimeout
}

// The session variables a dialog needs to appear on the user's desktop. Ordinary shell commands do
// not get them; elevated ones pass them to sudo, which hands them to the askpass helper.
var displayEnvKeys = []string{
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"DBUS_SESSION_BUS_ADDRESS",
	"XDG_RUNTIME_DIR",
	"XDG_SESSION_TYPE",
	"XDG_CURRENT_DESKTOP",
}

// Seams for tests.
var (
	lookPath   = exec.LookPath
	getenv     = os.Getenv
	executable = os.Executable
	// evalSymlinks resolves the system's pinentry link to the program it points at.
	evalSymlinks = filepath.EvalSymlinks
	goos         = runtime.GOOS
)

// askpassHandled records that this program answers askpass invocations: HandleAskpass ran at the
// start of main. sudo starts the running executable as the askpass helper, so a program that does
// not handle that (an embedding program that never calls HandleAskpass) would just start again.
var askpassHandled atomic.Bool

// HandleAskpass belongs at the start of main, before anything else. When sudo started this process
// as an elevated command's askpass helper, it shows the approval dialog, prints the password for
// sudo and exits. Otherwise it returns at once, and from then on elevated commands may use this
// executable as their helper: Check refuses them on Linux and macOS until it has run.
func HandleAskpass() {
	if IsAskpassInvocation() {
		AskpassMain()
	}
	askpassHandled.Store(true)
}

// Supported reports whether this OS has a way to elevate a command: sudo on Linux and macOS, UAC on
// Windows. Check says whether it can be used right now.
func Supported() bool {
	switch goos {
	case "linux", "darwin", "windows":
		return true
	}
	return false
}

// Check reports why an elevated command cannot run here, or nil when it can.
func Check(cfg Config) error {
	if !cfg.Enabled {
		return fmt.Errorf("elevated commands are turned off (%s.enabled)", cfg.key())
	}
	switch goos {
	case "windows":
		return nil
	case "darwin", "linux":
		return checkSudo(cfg)
	}
	return fmt.Errorf("elevated commands are not supported on %s", goos)
}

// checkSudo is Check on Linux and macOS: sudo, and an askpass program that can ask the user.
func checkSudo(cfg Config) error {
	if _, err := lookPath("sudo"); err != nil {
		return fmt.Errorf("sudo is not installed")
	}
	if strings.TrimSpace(cfg.Askpass) != "" {
		// The program shows its own dialog and knows where it can: it only has to exist.
		_, err := askpassProgram(cfg)
		return err
	}
	if !askpassHandled.Load() {
		return errAskpassUnhandled
	}
	if goos == "darwin" {
		if _, err := lookPath("osascript"); err != nil {
			return fmt.Errorf("osascript is not available to show the approval dialog")
		}
		return nil
	}
	if strings.TrimSpace(getenv("DISPLAY")) == "" && strings.TrimSpace(getenv("WAYLAND_DISPLAY")) == "" {
		return fmt.Errorf("there is no desktop session to show an approval dialog on")
	}
	_, err := chooseDialog(goos, cfg.Dialog)
	return err
}

// askpassProgram is the absolute path of cfg.Askpass, looked up on PATH when it is a bare name: sudo
// runs SUDO_ASKPASS as given, so it must not depend on the command's working directory.
func askpassProgram(cfg Config) (string, error) {
	name := strings.TrimSpace(cfg.Askpass)
	path, err := lookPath(name)
	if err != nil {
		return "", fmt.Errorf("the askpass program %q (%s.askpass) is not an executable file", name, cfg.key())
	}
	if abs, err := filepath.Abs(path); err == nil {
		path = abs
	}
	return path, nil
}

var errAskpassUnhandled = fmt.Errorf("this program does not show the approval dialog (an embedding program calls integration.RunAskpassIfRequested at the start of main)")

// SudoArgs is the sudo command line that runs argv (a shell and its arguments, ending with the
// command): -k ignores sudo's cached credentials, so every command asks; -A reads the password
// from the askpass helper; the empty -p leaves the wording to the helper's dialog.
func SudoArgs(argv []string) []string {
	args := []string{"-k", "-A", "-p", "", "--"}
	return append(args, argv...)
}

// SudoEnv is the environment for sudo: base (the shell tool's environment), the desktop session's
// display variables, and what the askpass program needs: the program as SUDO_ASKPASS (this binary,
// unless cfg.Askpass names another), the command to show and the deadline, and for this binary's
// helper the askpass switch and the dialog choice.
func SudoEnv(cfg Config, base []string, command string, now time.Time) ([]string, error) {
	external := strings.TrimSpace(cfg.Askpass) != ""
	var askpass string
	if external {
		program, err := askpassProgram(cfg)
		if err != nil {
			return nil, err
		}
		askpass = program
	} else {
		exe, err := executable()
		if err != nil {
			return nil, fmt.Errorf("find the mistermorph binary for the approval dialog: %w", err)
		}
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			exe = resolved
		}
		askpass = exe
	}
	env := append([]string(nil), base...)
	present := make(map[string]bool, len(env))
	for _, entry := range env {
		if i := strings.IndexByte(entry, '='); i > 0 {
			present[entry[:i]] = true
		}
	}
	for _, key := range displayEnvKeys {
		if present[key] {
			continue
		}
		if value := getenv(key); strings.TrimSpace(value) != "" {
			env = append(env, key+"="+value)
		}
	}
	env = append(env,
		"SUDO_ASKPASS="+askpass,
		EnvCommand+"="+command,
		EnvDeadline+"="+strconv.FormatInt(now.Add(cfg.Approval()).Unix(), 10),
	)
	if external {
		return env, nil
	}
	env = append(env, EnvAskpass+"=1")
	if dialog := strings.TrimSpace(cfg.Dialog); dialog != "" {
		env = append(env, EnvDialog+"="+dialog)
	}
	return env, nil
}

// DeclinedMarker is what the askpass helper writes to stderr when the user cancels the dialog, so
// the shell tool can tell a declined approval from a failed command. An external askpass program
// writes it as a line of its own; without it, a cancel reads as the command failing.
const DeclinedMarker = "mistermorph: administrator approval was declined"

// TimedOutMarker is what the askpass helper writes when nobody answered the dialog in time.
const TimedOutMarker = "mistermorph: administrator approval timed out"
