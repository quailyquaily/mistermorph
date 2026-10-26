package elevate

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// IsAskpassInvocation reports whether this process was started by sudo as the askpass helper.
func IsAskpassInvocation() bool {
	return getenv(EnvAskpass) == "1"
}

// RunAskpass is the askpass helper: it asks the approval session that started the elevated command
// for the password and prints it for sudo. It returns the process exit code: 0 with the password on
// stdout, 1 when the user declined, nobody answered in time or the session could not be reached
// (the reason goes to stderr, which sudo passes on).
func RunAskpass(stdout, stderr io.Writer) int {
	password, err := askSession()
	switch {
	case errors.Is(err, ErrDeclined):
		fmt.Fprintln(stderr, DeclinedMarker)
		return 1
	case errors.Is(err, ErrTimedOut):
		fmt.Fprintln(stderr, TimedOutMarker)
		return 1
	case err != nil:
		fmt.Fprintf(stderr, "mistermorph: the approval failed: %v\n", err)
		return 1
	}
	fmt.Fprintln(stdout, password)
	return 0
}

// maxShownCommand is how much of a command the dialog shows; a longer one is cut with "…".
const maxShownCommand = 600

// approvalTitle and approvalText are the dialog's words.
const approvalTitle = "MisterMorph needs administrator rights"

func approvalText(command string) string {
	command = strings.TrimSpace(command)
	if utf8.RuneCountInString(command) > maxShownCommand {
		command = string([]rune(command)[:maxShownCommand]) + "…"
	}
	who := "your"
	if u, err := user.Current(); err == nil && strings.TrimSpace(u.Username) != "" {
		who = u.Username + "'s"
	}
	return "MisterMorph wants to run this command as administrator:\n\n" + command +
		"\n\nEnter " + who + " password to allow it, or cancel to refuse."
}

// dialogConfigKey is the setting that names a dialog program; only bash elevates through sudo.
const dialogConfigKey = "tools.bash.elevation.dialog"

// dialogKind is how a dialog program is driven.
type dialogKind string

const (
	dialogPinentry  dialogKind = "pinentry"
	dialogZenity    dialogKind = "zenity"
	dialogKdialog   dialogKind = "kdialog"
	dialogOsascript dialogKind = "osascript"
)

type dialog struct {
	kind dialogKind
	path string
}

// The Linux dialogs, in order of preference, after the system's own pinentry (systemPinentry).
var linuxDialogs = []dialog{
	{dialogPinentry, "pinentry-gnome3"},
	{dialogPinentry, "pinentry-qt"},
	{dialogPinentry, "pinentry-qt5"},
	{dialogPinentry, "pinentry-gtk-2"},
	{dialogPinentry, "pinentry-gtk"},
	{dialogZenity, "zenity"},
	{dialogKdialog, "kdialog"},
}

// chooseDialog picks the dialog program: the configured one, osascript on macOS, or the first
// installed Linux dialog.
func chooseDialog(targetOS string, configured string) (dialog, error) {
	if configured = strings.TrimSpace(configured); configured != "" {
		path, err := lookPath(configured)
		if err != nil {
			return dialog{}, fmt.Errorf("the configured approval dialog %q is not installed (%s)", configured, dialogConfigKey)
		}
		kind, ok := dialogKindOf(filepath.Base(configured))
		if !ok {
			return dialog{}, fmt.Errorf("the configured approval dialog %q is not a pinentry, zenity, kdialog or osascript program", configured)
		}
		return dialog{kind: kind, path: path}, nil
	}
	if targetOS == "darwin" {
		path, err := lookPath("osascript")
		if err != nil {
			return dialog{}, fmt.Errorf("osascript is not available to show the approval dialog")
		}
		return dialog{kind: dialogOsascript, path: path}, nil
	}
	if path, ok := systemPinentry(); ok {
		return dialog{kind: dialogPinentry, path: path}, nil
	}
	for _, candidate := range linuxDialogs {
		if path, err := lookPath(candidate.path); err == nil {
			return dialog{kind: candidate.kind, path: path}, nil
		}
	}
	return dialog{}, fmt.Errorf("no approval dialog is installed (install pinentry-gnome3, pinentry-qt, zenity or kdialog, or set %s)", dialogConfigKey)
}

// terminalPinentries need a terminal, which elevated commands do not have.
var terminalPinentries = map[string]bool{
	"pinentry-curses": true,
	"pinentry-tty":    true,
	"pinentry-emacs":  true,
}

// systemPinentry is the program the system's "pinentry" points at (on Debian and Ubuntu, the
// update-alternatives choice), when that is a graphical one: the same dialog GnuPG and other
// programs use. A link to a terminal variant is passed over for the graphical ones.
func systemPinentry() (string, bool) {
	link, err := lookPath("pinentry")
	if err != nil {
		return "", false
	}
	target, err := evalSymlinks(link)
	if err != nil {
		return "", false
	}
	if terminalPinentries[strings.ToLower(filepath.Base(target))] {
		return "", false
	}
	return target, true
}

func dialogKindOf(name string) (dialogKind, bool) {
	name = strings.ToLower(strings.TrimSuffix(name, ".exe"))
	switch {
	case strings.Contains(name, "pinentry"):
		return dialogPinentry, true
	case name == "zenity":
		return dialogZenity, true
	case name == "kdialog":
		return dialogKdialog, true
	case name == "osascript":
		return dialogOsascript, true
	}
	return "", false
}

func (d dialog) ask(ctx context.Context, text string) (string, error) {
	switch d.kind {
	case dialogPinentry:
		return askPinentry(ctx, d.path, text)
	case dialogZenity:
		args := []string{"--entry", "--hide-text", "--title", approvalTitle, "--text", markupEscape(text)}
		if deadline, ok := ctx.Deadline(); ok {
			if secs := int(time.Until(deadline).Seconds()); secs > 0 {
				args = append(args, "--timeout", strconv.Itoa(secs))
			}
		}
		return askByOutput(ctx, d.path, args)
	case dialogKdialog:
		return askByOutput(ctx, d.path, []string{"--title", approvalTitle, "--password", text})
	case dialogOsascript:
		// The text is an argument to the script, never part of it.
		return askByOutput(ctx, d.path, []string{
			"-e", "on run argv",
			"-e", `display dialog (item 1 of argv) with title (item 2 of argv) default answer "" with hidden answer with icon caution buttons {"Cancel", "Allow"} default button "Allow" cancel button "Cancel"`,
			"-e", "return text returned of result",
			"-e", "end run",
			text, approvalTitle,
		})
	}
	return "", fmt.Errorf("unknown dialog %q", d.kind)
}

// askByOutput runs a dialog program that prints the password on stdout and exits non-zero when
// cancelled (zenity, kdialog, osascript).
func askByOutput(ctx context.Context, path string, args []string) (string, error) {
	cmd := exec.CommandContext(ctx, path, args...)
	cmd.Stderr = io.Discard
	out, err := cmd.Output()
	if ctx.Err() != nil {
		return "", ErrTimedOut
	}
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			// zenity exits 5 when its --timeout passes; any other refusal is a cancel.
			if filepath.Base(path) == "zenity" && exitErr.ExitCode() == 5 {
				return "", ErrTimedOut
			}
			return "", ErrDeclined
		}
		return "", err
	}
	return strings.TrimRight(string(out), "\r\n"), nil
}

// askPinentry drives a pinentry over its Assuan protocol: set the window's words, GETPIN, BYE.
func askPinentry(ctx context.Context, path string, text string) (string, error) {
	cmd := exec.CommandContext(ctx, path)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return "", err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", err
	}
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return "", err
	}
	defer func() {
		_ = stdin.Close()
		_ = cmd.Wait()
	}()
	reader := bufio.NewReader(stdoutPipe)
	// The greeting.
	if _, err := assuanResponse(reader); err != nil {
		return "", pinentryErr(ctx, err)
	}
	commands := []string{
		"SETTITLE " + assuanEscape(approvalTitle),
		"SETDESC " + assuanEscape(text),
		"SETPROMPT " + assuanEscape("Password:"),
		"SETOK " + assuanEscape("Allow"),
		"SETCANCEL " + assuanEscape("Cancel"),
	}
	if deadline, ok := ctx.Deadline(); ok {
		if secs := int(time.Until(deadline).Seconds()); secs > 0 {
			commands = append(commands, "SETTIMEOUT "+strconv.Itoa(secs))
		}
	}
	for _, command := range commands {
		if _, err := fmt.Fprintf(stdin, "%s\n", command); err != nil {
			return "", pinentryErr(ctx, err)
		}
		if _, err := assuanResponse(reader); err != nil {
			// An older pinentry may not know SETTIMEOUT or SETOK; the dialog still works.
			if errors.Is(err, errAssuanRefused) {
				continue
			}
			return "", pinentryErr(ctx, err)
		}
	}
	if _, err := fmt.Fprintf(stdin, "GETPIN\n"); err != nil {
		return "", pinentryErr(ctx, err)
	}
	data, err := assuanResponse(reader)
	if err != nil {
		if errors.Is(err, errAssuanRefused) {
			// pinentry answers ERR when the user cancels, and on its own timeout.
			if ctx.Err() != nil || strings.Contains(err.Error(), "Timeout") {
				return "", ErrTimedOut
			}
			return "", ErrDeclined
		}
		return "", pinentryErr(ctx, err)
	}
	_, _ = fmt.Fprintf(stdin, "BYE\n")
	return data, nil
}

func pinentryErr(ctx context.Context, err error) error {
	if ctx.Err() != nil {
		return ErrTimedOut
	}
	return err
}

var errAssuanRefused = errors.New("assuan ERR")

// assuanResponse reads lines up to the OK or ERR that ends a response, and returns the data lines
// ("D …"), decoded.
func assuanResponse(r *bufio.Reader) (string, error) {
	var data strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return "", fmt.Errorf("pinentry closed: %w", err)
		}
		line = strings.TrimRight(line, "\r\n")
		switch {
		case line == "OK" || strings.HasPrefix(line, "OK "):
			return data.String(), nil
		case strings.HasPrefix(line, "ERR"):
			return "", fmt.Errorf("%w: %s", errAssuanRefused, line)
		case strings.HasPrefix(line, "D "):
			data.WriteString(assuanUnescape(line[2:]))
		}
		// Status ("S …"), comments ("# …") and inquiries are not needed here.
	}
}

// assuanEscape percent-escapes what Assuan lines cannot carry.
func assuanEscape(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		switch c := s[i]; c {
		case '%', '\n', '\r':
			fmt.Fprintf(&out, "%%%02X", c)
		default:
			out.WriteByte(c)
		}
	}
	return out.String()
}

func assuanUnescape(s string) string {
	var out strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' && i+2 < len(s) {
			if v, err := strconv.ParseUint(s[i+1:i+3], 16, 8); err == nil {
				out.WriteByte(byte(v))
				i += 2
				continue
			}
		}
		out.WriteByte(s[i])
	}
	return out.String()
}

// markupEscape escapes the characters zenity would read as Pango markup.
func markupEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// AskpassMain runs the askpass helper and exits; main calls it before anything else when
// IsAskpassInvocation.
func AskpassMain() {
	os.Exit(RunAskpass(os.Stdout, os.Stderr))
}
