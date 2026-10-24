package elevate

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
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

	now := time.Unix(1_800_000_000, 0)
	base := []string{"PATH=/usr/bin:/bin", "HOME=/home/lyric", "XDG_RUNTIME_DIR=/run/user/1000"}
	env, err := SudoEnv(Config{Enabled: true, Dialog: "zenity"}, base, "apt-get install -y jq", now)
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
		"PATH":                     "/usr/bin:/bin",
		"WAYLAND_DISPLAY":          "wayland-1",
		"DBUS_SESSION_BUS_ADDRESS": "unix:path=/run/user/1000/bus",
		"SUDO_ASKPASS":             "/opt/morph/mistermorph",
		EnvAskpass:                 "1",
		EnvCommand:                 "apt-get install -y jq",
		EnvDialog:                  "zenity",
		EnvDeadline:                "1800000120",
	}
	for key, value := range wantValues {
		if values[key] != value {
			t.Errorf("env %s = %q, want %q", key, values[key], value)
		}
	}
	if got["XDG_RUNTIME_DIR"] != 1 {
		t.Errorf("XDG_RUNTIME_DIR appears %d times, want once", got["XDG_RUNTIME_DIR"])
	}
	if _, ok := values["OPENAI_API_KEY"]; ok {
		t.Error("an unrelated variable of the agent process reached sudo")
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
		{name: "cancelled", reply: "ERR 83886179 Operation cancelled <Pinentry>", wantErr: errDeclined},
		{name: "pinentry timeout", reply: "ERR 83886142 Timeout <Pinentry>", wantErr: errTimedOut},
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
		{name: "zenity cancelled", kind: dialogZenity, program: "zenity", body: "exit 1", wantErr: errDeclined},
		{name: "zenity timed out", kind: dialogZenity, program: "zenity", body: "exit 5", wantErr: errTimedOut},
		{name: "kdialog allowed", kind: dialogKdialog, program: "kdialog", body: `printf 'hunter2\n'`, want: "hunter2"},
		{name: "osascript cancelled", kind: dialogOsascript, program: "osascript", body: "exit 1", wantErr: errDeclined},
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
		body       string
		wantCode   int
		wantStdout string
		wantStderr string
	}{
		{name: "allowed", body: `printf 'hunter2\n'`, wantCode: 0, wantStdout: "hunter2\n"},
		{name: "declined", body: "exit 1", wantCode: 1, wantStderr: DeclinedMarker},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			path := writeScript(t, "zenity", tc.body+"\n")
			oldLook, oldEnv, oldOS := lookPath, getenv, goos
			t.Cleanup(func() { lookPath, getenv, goos = oldLook, oldEnv, oldOS })
			lookPath = func(name string) (string, error) {
				if name == "zenity" || name == path {
					return path, nil
				}
				return "", exec.ErrNotFound
			}
			getenv = func(key string) string {
				return map[string]string{EnvAskpass: "1", EnvCommand: "systemctl restart nginx", EnvDialog: "zenity"}[key]
			}
			goos = "linux"
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
