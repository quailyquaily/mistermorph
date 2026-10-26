// Package elevate runs a shell command with administrator rights after the user approves it in a
// system dialog (docs/feat/feat_20261024_elevated_commands.md).
//
// On Linux and macOS the command runs under `sudo -k -A`. sudo reads the password from an askpass
// program. By default the running mistermorph binary is that program: started with
// MISTERMORPH_ASKPASS=1 it asks the command's approval Session, prints the password for sudo and
// exits. The session asks the user through the run's Approver, or a dialog (pinentry, zenity or
// kdialog on Linux, osascript on macOS). A program of the user's own can take the helper's place
// (Config.Askpass); it gets the command and deadline from EnvCommand and EnvDeadline, and reports a
// declined or unanswered approval with DeclinedMarker or TimedOutMarker. The password is held in
// memory only to hand it to sudo: it is never logged, kept, or given to the model. On Windows the command runs in a powershell started with `-Verb RunAs`, which shows the
// UAC prompt (RunAsScript).
package elevate

import (
	"context"
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
	// EnvCommand is the command the user is asked to approve. An external askpass program gets it too.
	EnvCommand = "MISTERMORPH_ELEVATE_COMMAND"
	// EnvDeadline is when the ask gives up, in Unix seconds. An external askpass program gets it
	// too, and should give up then, writing TimedOutMarker.
	EnvDeadline = "MISTERMORPH_ELEVATE_DEADLINE"
	// EnvSocket and EnvToken lead the built-in helper to the command's approval Session.
	EnvSocket = "MISTERMORPH_ELEVATE_SOCKET"
	EnvToken  = "MISTERMORPH_ELEVATE_TOKEN"
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
	// Approver is where the approval is asked: ApproverAuto (the run's approver, set by the Console
	// or chat that started it, else the dialog), ApproverClient (only the run's approver) or
	// ApproverDialog (only the dialog). Empty means ApproverAuto.
	Approver string
}

// The values of Config.Approver.
const (
	ApproverAuto   = "auto"
	ApproverClient = "client"
	ApproverDialog = "dialog"
)

func (c Config) approverMode() string {
	switch mode := strings.ToLower(strings.TrimSpace(c.Approver)); mode {
	case ApproverClient, ApproverDialog:
		return mode
	}
	return ApproverAuto
}

// clientApprovals records that this process can ask the person who started a task to approve its
// elevated commands (the Console, chat), so they are offered without a desktop dialog.
var clientApprovals atomic.Bool

// OfferClientApprovals marks this process as one whose tasks may carry an approver (WithApprover):
// from then on, shell tools offer elevated commands where sudo is, even with no desktop dialog. A
// task without an approver then gets the reason when it tries one (CheckContext).
func OfferClientApprovals() {
	clientApprovals.Store(true)
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

// UsesAskpassProgram reports whether an askpass program of the user's own (Askpass) asks for the
// password, instead of an approval Session.
func (c Config) UsesAskpassProgram() bool {
	return strings.TrimSpace(c.Askpass) != ""
}

// The session variables a dialog needs to appear on the user's desktop. Ordinary shell commands do
// not get them; with an askpass program of the user's own, elevated ones pass them to sudo, which
// hands them to that program. The built-in dialog runs in this process, which has them.
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
// as an elevated command's askpass helper, it gets the password from the command's approval
// session, prints it for sudo and exits. Otherwise it returns at once, and from then on elevated commands may use this
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

// Offered reports whether a shell tool should offer elevated commands at all: Check passes, or this
// process asks clients to approve (OfferClientApprovals) and sudo can use its helper.
func Offered(cfg Config) bool {
	if Check(cfg) == nil {
		return true
	}
	return checkClientApprovals(cfg) == nil
}

// CheckContext is Check for a command run with ctx: with an approver on ctx (WithApprover), the
// desktop dialog is not needed.
func CheckContext(ctx context.Context, cfg Config) error {
	if !cfg.Enabled || goos == "windows" || cfg.UsesAskpassProgram() {
		return Check(cfg)
	}
	if _, ok := ApproverFromContext(ctx); ok && cfg.approverMode() != ApproverDialog {
		return checkHelper()
	}
	if cfg.approverMode() == ApproverClient {
		return fmt.Errorf("approval is asked only in the Console chat or chat that started the task (%s.approver: client), and this task was not started there", cfg.key())
	}
	return Check(cfg)
}

func checkClientApprovals(cfg Config) error {
	switch {
	case !cfg.Enabled:
		return fmt.Errorf("elevated commands are turned off (%s.enabled)", cfg.key())
	case goos != "linux" && goos != "darwin":
		return fmt.Errorf("elevated commands are not approved by clients on %s", goos)
	case cfg.UsesAskpassProgram() || cfg.approverMode() == ApproverDialog:
		return fmt.Errorf("elevated commands are approved in a dialog here")
	case !clientApprovals.Load():
		return fmt.Errorf("this program does not ask clients to approve elevated commands")
	}
	return checkHelper()
}

// checkHelper is what sudo with this binary as its helper needs, whoever asks the user.
func checkHelper() error {
	if _, err := lookPath("sudo"); err != nil {
		return fmt.Errorf("sudo is not installed")
	}
	if !askpassHandled.Load() {
		return errAskpassUnhandled
	}
	return nil
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
// from the askpass helper; the empty -p leaves the wording to the approval.
func SudoArgs(argv []string) []string {
	args := []string{"-k", "-A", "-p", "", "--"}
	return append(args, argv...)
}

// SudoEnv is the environment for sudo: base (the shell tool's environment) and what the askpass
// program needs: the program as SUDO_ASKPASS, the command and the deadline (Request.Deadline).
// For this binary's helper that is also the askpass switch and session's address (Session.Env);
// session is nil only with an askpass program of the user's own (cfg.Askpass), which also gets the
// desktop session's display variables, to show its own dialog.
func SudoEnv(cfg Config, base []string, command string, deadline time.Time, session *Session) ([]string, error) {
	external := cfg.UsesAskpassProgram()
	if !external && session == nil {
		return nil, fmt.Errorf("an elevated command needs an approval session")
	}
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
	if external {
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
	}
	env = append(env,
		"SUDO_ASKPASS="+askpass,
		EnvCommand+"="+command,
		EnvDeadline+"="+strconv.FormatInt(deadline.Unix(), 10),
	)
	if external {
		return env, nil
	}
	env = append(env, EnvAskpass+"=1")
	return append(env, session.Env()...), nil
}

// DeclinedMarker is what the askpass helper writes to stderr when the user cancels the dialog, so
// the shell tool can tell a declined approval from a failed command. An external askpass program
// writes it as a line of its own; without it, a cancel reads as the command failing.
const DeclinedMarker = "mistermorph: administrator approval was declined"

// TimedOutMarker is what the askpass helper writes when nobody answered the dialog in time.
const TimedOutMarker = "mistermorph: administrator approval timed out"
