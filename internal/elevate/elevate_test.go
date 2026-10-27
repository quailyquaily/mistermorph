package elevate

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf16"
)

// fakeEnv swaps the package's seams for one test.
func fakeEnv(t *testing.T, targetOS string, env map[string]string, installed ...string) {
	t.Helper()
	oldLook, oldEnv, oldOS, oldExe, oldEval := lookPath, getenv, goos, executable, evalSymlinks
	t.Cleanup(func() { lookPath, getenv, goos, executable, evalSymlinks = oldLook, oldEnv, oldOS, oldExe, oldEval })
	// No links unless a test sets them.
	evalSymlinks = func(path string) (string, error) { return path, nil }
	// As the mistermorph binary does at the start of main; TestCheck covers a program that does not.
	oldHandled := askpassHandled.Load()
	askpassHandled.Store(true)
	t.Cleanup(func() { askpassHandled.Store(oldHandled) })
	have := map[string]string{}
	for _, name := range installed {
		have[name] = "/usr/bin/" + name
	}
	lookPath = func(name string) (string, error) {
		if path, ok := have[name]; ok {
			return path, nil
		}
		if path, ok := have[filepath.Base(name)]; ok && filepath.IsAbs(name) {
			return path, nil
		}
		return "", exec.ErrNotFound
	}
	getenv = func(key string) string { return env[key] }
	goos = targetOS
	executable = func() (string, error) { return "/opt/morph/mistermorph", nil }
}

func TestCheck(t *testing.T) {
	desktop := map[string]string{"WAYLAND_DISPLAY": "wayland-1"}
	cases := []struct {
		name      string
		os        string
		cfg       Config
		env       map[string]string
		installed []string
		unhandled bool
		wantErr   string
	}{
		{name: "turned off", os: "linux", cfg: Config{}, env: desktop, installed: []string{"sudo", "zenity"}, wantErr: "turned off"},
		{name: "linux desktop with pinentry", os: "linux", cfg: Config{Enabled: true}, env: desktop, installed: []string{"sudo", "pinentry-gnome3"}},
		{name: "linux X11 with zenity", os: "linux", cfg: Config{Enabled: true}, env: map[string]string{"DISPLAY": ":0"}, installed: []string{"sudo", "zenity"}},
		{name: "linux without sudo", os: "linux", cfg: Config{Enabled: true}, env: desktop, installed: []string{"zenity"}, wantErr: "sudo is not installed"},
		{name: "linux headless", os: "linux", cfg: Config{Enabled: true}, env: map[string]string{}, installed: []string{"sudo", "zenity"}, wantErr: "no desktop session"},
		{name: "linux without a dialog", os: "linux", cfg: Config{Enabled: true}, env: desktop, installed: []string{"sudo", "pinentry-curses"}, wantErr: "no approval dialog"},
		{name: "linux configured dialog missing", os: "linux", cfg: Config{Enabled: true, Dialog: "pinentry-qt"}, env: desktop, installed: []string{"sudo", "zenity"}, wantErr: "not installed"},
		{name: "macos", os: "darwin", cfg: Config{Enabled: true}, installed: []string{"sudo", "osascript"}},
		{name: "macos without osascript", os: "darwin", cfg: Config{Enabled: true}, installed: []string{"sudo"}, wantErr: "osascript"},
		{name: "windows", os: "windows", cfg: Config{Enabled: true}},
		{name: "other", os: "plan9", cfg: Config{Enabled: true}, wantErr: "not supported"},
		// An embedding program that never called HandleAskpass (integration.RunAskpassIfRequested).
		{name: "linux host without the askpass hook", os: "linux", cfg: Config{Enabled: true}, env: desktop, installed: []string{"sudo", "zenity"}, unhandled: true, wantErr: "integration.RunAskpassIfRequested"},
		{name: "macos host without the askpass hook", os: "darwin", cfg: Config{Enabled: true}, installed: []string{"sudo", "osascript"}, unhandled: true, wantErr: "does not show the approval dialog"},
		{name: "windows host without the askpass hook", os: "windows", cfg: Config{Enabled: true}, unhandled: true},
		// An askpass program of the user's own shows its own dialog: it needs no hook, no display
		// and none of the dialogs the helper knows.
		{name: "linux askpass program", os: "linux", cfg: Config{Enabled: true, Askpass: "inua-askpass"}, env: map[string]string{}, installed: []string{"sudo", "inua-askpass"}, unhandled: true},
		{name: "linux askpass program by path", os: "linux", cfg: Config{Enabled: true, Askpass: "/opt/inua/bin/inua-askpass"}, installed: []string{"sudo", "inua-askpass"}},
		{name: "macos askpass program", os: "darwin", cfg: Config{Enabled: true, Askpass: "inua-askpass"}, installed: []string{"sudo", "inua-askpass"}, unhandled: true},
		{name: "askpass program missing", os: "linux", cfg: Config{Enabled: true, Askpass: "inua-askpass", Key: "tools.bash.elevation"}, env: desktop, installed: []string{"sudo", "zenity"}, wantErr: "tools.bash.elevation.askpass"},
		{name: "askpass program without sudo", os: "linux", cfg: Config{Enabled: true, Askpass: "inua-askpass"}, installed: []string{"inua-askpass"}, wantErr: "sudo is not installed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fakeEnv(t, tc.os, tc.env, tc.installed...)
			if tc.unhandled {
				askpassHandled.Store(false)
			}
			err := Check(tc.cfg)
			if tc.wantErr == "" {
				if err != nil {
					t.Fatalf("Check() = %v, want nil", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("Check() = %v, want an error containing %q", err, tc.wantErr)
			}
		})
	}
}

func TestChooseDialogFollowsTheSystemPinentry(t *testing.T) {
	cases := []struct {
		name   string
		target string
		want   string
	}{
		{name: "a custom pinentry chosen with update-alternatives", target: "/usr/local/bin/inua-pinentry", want: "/usr/local/bin/inua-pinentry"},
		{name: "the GNOME pinentry", target: "/usr/bin/pinentry-gnome3", want: "/usr/bin/pinentry-gnome3"},
		{name: "a terminal pinentry is passed over", target: "/usr/bin/pinentry-curses", want: "/usr/bin/pinentry-gnome3"},
		{name: "a tty pinentry is passed over", target: "/usr/bin/pinentry-tty", want: "/usr/bin/pinentry-gnome3"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fakeEnv(t, "linux", nil, "pinentry", "pinentry-gnome3", "zenity")
			evalSymlinks = func(path string) (string, error) {
				if path == "/usr/bin/pinentry" {
					return tc.target, nil
				}
				return path, nil
			}
			got, err := chooseDialog("linux", "")
			if err != nil || got != (dialog{dialogPinentry, tc.want}) {
				t.Fatalf("chooseDialog() = %+v, %v; want %s", got, err, tc.want)
			}
		})
	}
	// A configured dialog still comes first.
	fakeEnv(t, "linux", nil, "pinentry", "zenity")
	evalSymlinks = func(string) (string, error) { return "/usr/local/bin/inua-pinentry", nil }
	if got, _ := chooseDialog("linux", "zenity"); got.kind != dialogZenity {
		t.Fatalf("the configured dialog lost to the system pinentry: %+v", got)
	}
}

func TestChooseDialogPrefersPinentryThenZenityThenKdialog(t *testing.T) {
	cases := []struct {
		installed  []string
		configured string
		want       dialog
	}{
		{installed: []string{"kdialog", "zenity", "pinentry-gnome3"}, want: dialog{dialogPinentry, "/usr/bin/pinentry-gnome3"}},
		{installed: []string{"kdialog", "zenity", "pinentry-curses"}, want: dialog{dialogZenity, "/usr/bin/zenity"}},
		{installed: []string{"kdialog"}, want: dialog{dialogKdialog, "/usr/bin/kdialog"}},
		{installed: []string{"zenity", "pinentry-qt"}, configured: "zenity", want: dialog{dialogZenity, "/usr/bin/zenity"}},
		// A custom pinentry, such as the one gpg-agent's pinentry-program names.
		{installed: []string{"zenity", "inua-pinentry"}, configured: "inua-pinentry", want: dialog{dialogPinentry, "/usr/bin/inua-pinentry"}},
	}
	for _, tc := range cases {
		fakeEnv(t, "linux", nil, tc.installed...)
		got, err := chooseDialog("linux", tc.configured)
		if err != nil || got != tc.want {
			t.Errorf("chooseDialog(%v, %q) = %+v, %v; want %+v", tc.installed, tc.configured, got, err, tc.want)
		}
	}
	fakeEnv(t, "linux", nil, "zenity", "gpg")
	if _, err := chooseDialog("linux", "gpg"); err == nil || !strings.Contains(err.Error(), "not a pinentry") {
		t.Fatalf("an unknown configured program: err = %v", err)
	}
}

func TestSudoArgsAndEnv(t *testing.T) {
	fakeEnv(t, "linux", map[string]string{
		"WAYLAND_DISPLAY":          "wayland-1",
		"DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
		"XDG_RUNTIME_DIR":          "/run/user/1000",
		"OPENAI_API_KEY":           "sk-never-passed",
	})
	args := SudoArgs([]string{"bash", "-c", "apt-get install -y jq"})
	want := []string{"-k", "-A", "-p", "", "--", "bash", "-c", "apt-get install -y jq"}
	if strings.Join(args, "\x00") != strings.Join(want, "\x00") {
		t.Fatalf("SudoArgs = %q, want %q", args, want)
	}

	deadline := time.Unix(1_800_000_120, 0)
	base := []string{"PATH=/usr/bin:/bin", "HOME=/home/lyric", "XDG_RUNTIME_DIR=/run/user/1000"}
	session := beginTestSession(t, nil)
	env, err := SudoEnv(Config{Enabled: true, Dialog: "zenity"}, base, "apt-get install -y jq", deadline, session)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]int{}
	values := map[string]string{}
	for _, entry := range env {
		key, value, _ := strings.Cut(entry, "=")
		got[key]++
		values[key] = value
	}
	wantValues := map[string]string{
		"PATH":         "/usr/bin:/bin",
		"SUDO_ASKPASS": "/opt/morph/mistermorph",
		EnvAskpass:     "1",
		EnvCommand:     "apt-get install -y jq",
		EnvDeadline:    "1800000120",
		EnvSocket:      session.listener.Addr().String(),
		EnvToken:       session.token,
	}
	for key, value := range wantValues {
		if values[key] != value {
			t.Errorf("env %s = %q, want %q", key, values[key], value)
		}
	}
	if got["XDG_RUNTIME_DIR"] != 1 {
		t.Errorf("XDG_RUNTIME_DIR appears %d times, want once", got["XDG_RUNTIME_DIR"])
	}
	// The dialog runs in this process: the helper needs no display, and nothing else of ours.
	for _, key := range []string{"WAYLAND_DISPLAY", "DBUS_SESSION_BUS_ADDRESS", "OPENAI_API_KEY"} {
		if _, ok := values[key]; ok {
			t.Errorf("%s of the agent process reached sudo", key)
		}
	}
	if _, err := SudoEnv(Config{Enabled: true}, base, "apt-get install -y jq", deadline, nil); err == nil {
		t.Error("SudoEnv without a session or an askpass program: err = nil")
	}
}

func TestSudoEnvWithAnAskpassProgram(t *testing.T) {
	deadline := time.Unix(1_800_000_120, 0)
	cases := []struct {
		name    string
		cfg     Config
		want    map[string]string
		absent  []string
		wantErr string
	}{
		{
			name:   "built-in helper",
			cfg:    Config{Enabled: true, Dialog: "zenity"},
			want:   map[string]string{"SUDO_ASKPASS": "/opt/morph/mistermorph", EnvAskpass: "1", EnvCommand: "systemctl restart nginx", EnvDeadline: "1800000120"},
			absent: []string{"WAYLAND_DISPLAY"},
		},
		{
			// The helper's switch and session mean nothing to another program, which shows its own
			// dialog and so gets the display.
			name:   "askpass program",
			cfg:    Config{Enabled: true, Dialog: "zenity", Askpass: "inua-askpass"},
			want:   map[string]string{"SUDO_ASKPASS": "/usr/bin/inua-askpass", EnvCommand: "systemctl restart nginx", EnvDeadline: "1800000120", "WAYLAND_DISPLAY": "wayland-1"},
			absent: []string{EnvAskpass, EnvSocket, EnvToken},
		},
		{
			name:    "askpass program missing",
			cfg:     Config{Enabled: true, Askpass: "nowhere-askpass"},
			wantErr: "not an executable file",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fakeEnv(t, "linux", map[string]string{"WAYLAND_DISPLAY": "wayland-1"}, "inua-askpass")
			var session *Session
			if !tc.cfg.UsesAskpassProgram() {
				session = beginTestSession(t, nil)
			}
			env, err := SudoEnv(tc.cfg, []string{"PATH=/usr/bin:/bin"}, "systemctl restart nginx", deadline, session)
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("SudoEnv() error = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			values := map[string]string{}
			for _, entry := range env {
				key, value, _ := strings.Cut(entry, "=")
				values[key] = value
			}
			for key, value := range tc.want {
				if values[key] != value {
					t.Errorf("env %s = %q, want %q", key, values[key], value)
				}
			}
			for _, key := range tc.absent {
				if _, ok := values[key]; ok {
					t.Errorf("env has %s", key)
				}
			}
		})
	}
}

// writeScript writes an executable shell script for a fake dialog program.
func writeScript(t *testing.T, name, body string) string {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("fake dialogs are shell scripts")
	}
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return path
}

// A pinentry that answers each command, logs what it was told, and returns pin (or cancels).
func fakePinentry(t *testing.T, logPath, getpinReply string) string {
	return writeScript(t, "pinentry-gnome3", `echo "OK Pleased to meet you"
while IFS= read -r line; do
  echo "$line" >> `+logPath+`
  case "$line" in
    GETPIN) printf '%s\n' "`+getpinReply+`" ;;
    BYE) echo OK; exit 0 ;;
    SETTIMEOUT*) echo "ERR 536871187 Unknown command" ;;
    *) echo OK ;;
  esac
done
`)
}

func TestPinentryDialog(t *testing.T) {
	cases := []struct {
		name    string
		reply   string
		want    string
		wantErr error
	}{
		{name: "allowed", reply: `D p%25ss word%0A\nOK`, want: "p%ss word\n"},
		{name: "cancelled", reply: "ERR 83886179 Operation cancelled <Pinentry>", wantErr: ErrDeclined},
		{name: "pinentry timeout", reply: "ERR 83886142 Timeout <Pinentry>", wantErr: ErrTimedOut},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			logPath := filepath.Join(t.TempDir(), "commands.log")
			reply := strings.ReplaceAll(tc.reply, `\n`, "\n")
			path := fakePinentry(t, logPath, reply)
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			defer cancel()
			got, err := dialog{dialogPinentry, path}.ask(ctx, "run this:\napt-get install 100% jq")
			if !errors.Is(err, tc.wantErr) || got != tc.want {
				t.Fatalf("ask() = %q, %v; want %q, %v", got, err, tc.want, tc.wantErr)
			}
			log, _ := os.ReadFile(logPath)
			if !strings.Contains(string(log), "SETDESC run this:%0Aapt-get install 100%25 jq") || !strings.Contains(string(log), "GETPIN") {
				t.Fatalf("pinentry was told:\n%s", log)
			}
		})
	}
}

func TestOutputDialogs(t *testing.T) {
	cases := []struct {
		name    string
		kind    dialogKind
		program string
		body    string
		want    string
		wantErr error
	}{
		{name: "zenity allowed", kind: dialogZenity, program: "zenity", body: `printf 'hunter2\n'`, want: "hunter2"},
		{name: "zenity cancelled", kind: dialogZenity, program: "zenity", body: "exit 1", wantErr: ErrDeclined},
		{name: "zenity timed out", kind: dialogZenity, program: "zenity", body: "exit 5", wantErr: ErrTimedOut},
		{name: "kdialog allowed", kind: dialogKdialog, program: "kdialog", body: `printf 'hunter2\n'`, want: "hunter2"},
		{name: "osascript cancelled", kind: dialogOsascript, program: "osascript", body: "exit 1", wantErr: ErrDeclined},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeScript(t, tc.program, tc.body+"\n")
			got, err := dialog{tc.kind, path}.ask(context.Background(), "a <b> & c")
			if !errors.Is(err, tc.wantErr) || got != tc.want {
				t.Fatalf("ask() = %q, %v; want %q, %v", got, err, tc.want, tc.wantErr)
			}
		})
	}
}

func TestZenityGetsEscapedTextAndTimeout(t *testing.T) {
	argsPath := filepath.Join(t.TempDir(), "args")
	path := writeScript(t, "zenity", `for a in "$@"; do printf '%s\n' "$a" >> `+argsPath+`; done; printf 'pw\n'`+"\n")
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	if _, err := (dialog{dialogZenity, path}).ask(ctx, "rm -rf <dir> && echo"); err != nil {
		t.Fatal(err)
	}
	args, _ := os.ReadFile(argsPath)
	for _, want := range []string{"--hide-text", "rm -rf &lt;dir&gt; &amp;&amp; echo", "--timeout"} {
		if !strings.Contains(string(args), want) {
			t.Errorf("zenity args lack %q:\n%s", want, args)
		}
	}
}

func TestRunAskpass(t *testing.T) {
	cases := []struct {
		name       string
		approver   Approver
		token      string
		wantCode   int
		wantStdout string
		wantStderr string
	}{
		{name: "allowed", approver: answer("hunter2", nil), wantCode: 0, wantStdout: "hunter2\n"},
		{name: "declined", approver: answer("", ErrDeclined), wantCode: 1, wantStderr: DeclinedMarker},
		{name: "timed out", approver: answer("", ErrTimedOut), wantCode: 1, wantStderr: TimedOutMarker},
		{name: "approver failed", approver: answer("", errors.New("no dialog")), wantCode: 1, wantStderr: "the approval failed: no dialog"},
		{name: "wrong token", approver: answer("hunter2", nil), token: "not-the-token", wantCode: 1, wantStderr: "this approval is not open"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			session := beginTestSession(t, tc.approver)
			helperEnv(t, session, tc.token)
			if !IsAskpassInvocation() {
				t.Fatal("IsAskpassInvocation() = false")
			}
			var stdout, stderr bytes.Buffer
			code := RunAskpass(&stdout, &stderr)
			if code != tc.wantCode || stdout.String() != tc.wantStdout || !strings.Contains(stderr.String(), tc.wantStderr) {
				t.Fatalf("RunAskpass = %d, stdout %q, stderr %q", code, stdout.String(), stderr.String())
			}
		})
	}
}

// The token is readable by any process of this user, so it is not enough: only a child of the
// command's sudo process is answered, and nothing is before sudo started.
func TestSessionAnswersOnlySudosHelper(t *testing.T) {
	asked := false
	approver := ApproverFunc(func(context.Context, Request) (string, error) {
		asked = true
		return "hunter2", nil
	})
	t.Run("another process with the token", func(t *testing.T) {
		session := beginTestSession(t, approver)
		// sudo is some other process: this one is not its child.
		session.Started(os.Getpid())
		helperEnv(t, session, "")
		var stdout, stderr bytes.Buffer
		if code := RunAskpass(&stdout, &stderr); code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "only sudo's askpass helper") {
			t.Fatalf("RunAskpass = %d, stdout %q, stderr %q", code, stdout.String(), stderr.String())
		}
	})
	t.Run("before sudo started", func(t *testing.T) {
		old := helperHandshakeTimeout
		helperHandshakeTimeout = 200 * time.Millisecond
		t.Cleanup(func() { helperHandshakeTimeout = old })
		session := beginTestSession(t, approver)
		env := map[string]string{EnvAskpass: "1"}
		for _, entry := range session.Env() {
			key, value, _ := strings.Cut(entry, "=")
			env[key] = value
		}
		oldEnv := getenv
		t.Cleanup(func() { getenv = oldEnv })
		getenv = func(key string) string { return env[key] }
		var stdout, stderr bytes.Buffer
		if code := RunAskpass(&stdout, &stderr); code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "this approval is not open") {
			t.Fatalf("RunAskpass = %d, stdout %q, stderr %q", code, stdout.String(), stderr.String())
		}
	})
	if asked {
		t.Fatal("the approver was asked for a process that is not sudo's helper")
	}
}

func TestParentProcess(t *testing.T) {
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		t.Skip("Linux and macOS only")
	}
	if got, err := parentProcess(os.Getpid()); err != nil || got != os.Getppid() {
		t.Fatalf("parentProcess = %d, %v, want %d", got, err, os.Getppid())
	}
}

func TestRunAskpassWithoutASession(t *testing.T) {
	oldEnv := getenv
	t.Cleanup(func() { getenv = oldEnv })
	getenv = func(key string) string { return map[string]string{EnvAskpass: "1"}[key] }
	var stdout, stderr bytes.Buffer
	if code := RunAskpass(&stdout, &stderr); code != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "without an approval session") {
		t.Fatalf("RunAskpass = %d, stdout %q, stderr %q", code, stdout.String(), stderr.String())
	}
}

// A session asks its approver once per helper start, telling it which try this is, and gives the
// approver the command, its directory and the deadline.
func TestSessionAsksTheApproverForEachTry(t *testing.T) {
	var seen []Request
	approver := ApproverFunc(func(ctx context.Context, req Request) (string, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("the approver's context has no deadline")
		}
		seen = append(seen, req)
		return []string{"letmein", "hunter2"}[req.Attempt-1], nil
	})
	session := beginTestSession(t, approver)
	helperEnv(t, session, "")
	var got []string
	for range 2 {
		var stdout, stderr bytes.Buffer
		if code := RunAskpass(&stdout, &stderr); code != 0 {
			t.Fatalf("RunAskpass = %d, stderr %q", code, stderr.String())
		}
		got = append(got, strings.TrimSpace(stdout.String()))
	}
	if strings.Join(got, ",") != "letmein,hunter2" {
		t.Fatalf("passwords = %q", got)
	}
	if len(seen) != 2 || seen[0].Attempt != 1 || seen[1].Attempt != 2 ||
		seen[0].Command != "apt-get install -y jq" || seen[0].Dir != "/srv/app" || seen[0].Deadline.IsZero() {
		t.Fatalf("requests = %+v", seen)
	}
}

// Ending the session (the command gave up) ends an ask in progress, and the helper reports it as
// unanswered.
func TestSessionEndStopsTheAsk(t *testing.T) {
	asking := make(chan struct{})
	approver := ApproverFunc(func(ctx context.Context, req Request) (string, error) {
		close(asking)
		<-ctx.Done()
		return "", ctx.Err()
	})
	session, err := Begin(context.Background(), Config{}, "apt-get install -y jq", "/srv/app", time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	session.approver = approver
	helperEnv(t, session, "")
	done := make(chan int)
	var stderr bytes.Buffer
	go func() { done <- RunAskpass(io.Discard, &stderr) }()
	<-asking
	ended := make(chan struct{})
	go func() {
		session.End()
		close(ended)
	}()
	select {
	case code := <-done:
		if code != 1 || !strings.Contains(stderr.String(), TimedOutMarker) {
			t.Fatalf("RunAskpass = %d, stderr %q", code, stderr.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the helper still waits after the session ended")
	}
	// The helper hears that the ask ended before End removes the socket's directory.
	select {
	case <-ended:
	case <-time.After(5 * time.Second):
		t.Fatal("End did not return")
	}
	if _, err := os.Stat(session.dir); !os.IsNotExist(err) {
		t.Fatalf("the socket's directory is still there: %v", err)
	}
}

// Without an approver on the context, the session asks in the desktop dialog.
func TestSessionFallsBackToTheDialog(t *testing.T) {
	path := writeScript(t, "zenity", "printf 'hunter2\\n'\n")
	session, err := Begin(context.Background(), Config{Dialog: path}, "systemctl restart nginx", "/", time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.End)
	helperEnv(t, session, "")
	var stdout, stderr bytes.Buffer
	if code := RunAskpass(&stdout, &stderr); code != 0 || stdout.String() != "hunter2\n" {
		t.Fatalf("RunAskpass = %d, stdout %q, stderr %q", code, stdout.String(), stderr.String())
	}
}

func answer(password string, err error) Approver {
	return ApproverFunc(func(context.Context, Request) (string, error) { return password, err })
}

// beginTestSession opens a session for "apt-get install -y jq" in /srv/app, asking approver.
func beginTestSession(t *testing.T, approver Approver) *Session {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("approval sessions serve sudo on Linux and macOS")
	}
	ctx := context.Background()
	if approver != nil {
		ctx = WithApprover(ctx, approver)
	}
	session, err := Begin(ctx, Config{}, "apt-get install -y jq", "/srv/app", time.Now().Add(time.Minute))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(session.End)
	return session
}

// helperEnv makes this process see the environment sudo gives the helper for session, with token
// in place of the session's when it is set. The helper is this process, so its parent plays sudo.
func helperEnv(t *testing.T, session *Session, token string) {
	t.Helper()
	session.Started(os.Getppid())
	env := map[string]string{EnvAskpass: "1", EnvDeadline: strconv.FormatInt(session.req.Deadline.Unix(), 10)}
	for _, entry := range session.Env() {
		key, value, _ := strings.Cut(entry, "=")
		env[key] = value
	}
	if token != "" {
		env[EnvToken] = token
	}
	oldEnv := getenv
	t.Cleanup(func() { getenv = oldEnv })
	getenv = func(key string) string { return env[key] }
}

func TestApprovalTextShowsTheCommandAndCutsALongOne(t *testing.T) {
	text := approvalText("  systemctl restart nginx  ")
	if !strings.Contains(text, "\n\nsystemctl restart nginx\n\n") {
		t.Fatalf("approvalText = %q", text)
	}
	long := approvalText(strings.Repeat("x", 2000))
	if !strings.Contains(long, strings.Repeat("x", maxShownCommand)+"…") || strings.Contains(long, strings.Repeat("x", maxShownCommand+1)) {
		t.Fatal("a long command was not cut at the limit")
	}
}

func TestAssuanEscaping(t *testing.T) {
	for _, s := range []string{"plain", "100%", "line\nnext\r", "%%0A"} {
		if got := assuanUnescape(assuanEscape(s)); got != s {
			t.Errorf("round trip of %q = %q", s, got)
		}
		if strings.ContainsAny(assuanEscape(s), "\n\r") {
			t.Errorf("assuanEscape(%q) keeps a line break", s)
		}
	}
}

func decodeCommand(t *testing.T, encoded string) string {
	t.Helper()
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(raw)%2 != 0 {
		t.Fatalf("not UTF-16LE Base64: %v", err)
	}
	units := make([]uint16, len(raw)/2)
	for i := range units {
		units[i] = uint16(raw[2*i]) | uint16(raw[2*i+1])<<8
	}
	return string(utf16.Decode(units))
}

func TestRunAsScript(t *testing.T) {
	command := `Get-Service "Spooler" | Restart-Service; Write-Output 'done ✓'`
	script := RunAsScript(command, `C:\Users\O'Neil\work`, `C:\Temp\mm-elevated-1.log`)
	for _, want := range []string{"-Verb RunAs", "-Wait -PassThru", "exit $p.ExitCode", "1223", DeclinedMarker, `'C:\Temp\mm-elevated-1.log'`} {
		if !strings.Contains(script, want) {
			t.Errorf("outer script lacks %q:\n%s", want, script)
		}
	}
	if strings.Contains(script, `"`) {
		t.Errorf("outer script has a double quote, which the command line could mangle:\n%s", script)
	}
	start := strings.Index(script, "'-EncodedCommand', '") + len("'-EncodedCommand', '")
	end := strings.Index(script[start:], "'")
	inner := decodeCommand(t, script[start:start+end])
	for _, want := range []string{"Set-Location -LiteralPath 'C:\\Users\\O''Neil\\work'", command, "*>&1 | Out-File -LiteralPath $out", "exit $code"} {
		if !strings.Contains(inner, want) {
			t.Errorf("inner script lacks %q:\n%s", want, inner)
		}
	}
	if strings.Contains(RunAsScript("whoami", "", `C:\t.log`), "Set-Location") {
		t.Error("an empty cwd still changes directory")
	}
}

func TestRunAsScriptParsesInPowerShell(t *testing.T) {
	pwsh, err := exec.LookPath("pwsh")
	if err != nil {
		t.Skip("pwsh is not installed")
	}
	script := RunAsScript("Write-Output 'hi'", `C:\work`, `C:\t.log`)
	check := "$errors = $null; [System.Management.Automation.Language.Parser]::ParseInput($env:MM_SCRIPT, [ref]$null, [ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }"
	cmd := exec.Command(pwsh, "-NoProfile", "-Command", check)
	cmd.Env = append(os.Environ(), "MM_SCRIPT="+script)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("the script does not parse: %v\n%s", err, out)
	}
}

// With an approver on the run (the Console, chat), elevated commands need sudo and the helper, not
// a desktop; approver "client" refuses runs without one, and "dialog" ignores it.
func TestCheckContextAndOffered(t *testing.T) {
	withApprover := WithApprover(context.Background(), answer("hunter2", nil))
	cases := []struct {
		name        string
		cfg         Config
		ctx         context.Context
		clients     bool
		installed   []string
		wantErr     string
		wantOffered bool
	}{
		{name: "approver, no desktop", cfg: Config{Enabled: true}, ctx: withApprover, clients: true, installed: []string{"sudo"}, wantOffered: true},
		{name: "no approver, no desktop", cfg: Config{Enabled: true}, ctx: context.Background(), clients: true, installed: []string{"sudo"}, wantErr: "no desktop session", wantOffered: true},
		{name: "approver client, none on the run", cfg: Config{Enabled: true, Approver: "client"}, ctx: context.Background(), clients: true, installed: []string{"sudo"}, wantErr: "only in the Console chat or chat", wantOffered: true},
		{name: "approver dialog ignores the run's", cfg: Config{Enabled: true, Approver: "dialog"}, ctx: withApprover, clients: true, installed: []string{"sudo"}, wantErr: "no desktop session", wantOffered: false},
		{name: "program without client approvals", cfg: Config{Enabled: true}, ctx: withApprover, clients: false, installed: []string{"sudo"}, wantOffered: false},
		{name: "no sudo", cfg: Config{Enabled: true}, ctx: withApprover, clients: true, wantErr: "sudo is not installed", wantOffered: false},
		{name: "turned off", cfg: Config{}, ctx: withApprover, clients: true, installed: []string{"sudo"}, wantErr: "turned off", wantOffered: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fakeEnv(t, "linux", nil, tc.installed...)
			old := clientApprovals.Load()
			clientApprovals.Store(tc.clients)
			t.Cleanup(func() { clientApprovals.Store(old) })
			err := CheckContext(tc.ctx, tc.cfg)
			if tc.wantErr == "" && err != nil {
				t.Fatalf("CheckContext() = %v", err)
			}
			if tc.wantErr != "" && (err == nil || !strings.Contains(err.Error(), tc.wantErr)) {
				t.Fatalf("CheckContext() = %v, want %q", err, tc.wantErr)
			}
			if got := Offered(tc.cfg); got != tc.wantOffered {
				t.Fatalf("Offered() = %v, want %v", got, tc.wantOffered)
			}
		})
	}
}
