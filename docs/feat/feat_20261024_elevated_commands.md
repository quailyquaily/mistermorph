---
date: 2026-10-24
title: Elevated commands, administrator approval through a system dialog
status: implemented
---

# Elevated commands

## 1) Problem

System work often needs root: installing a package, editing `/etc`, restarting a system service.
Today the agent cannot do it. The shell tools run each command in a new session with no terminal
(`Setsid`, stdin redirected), so `sudo` has nowhere to ask for a password and fails with "a
terminal is required". The model then tells the user to run the command themselves.

Every desktop OS has a sanctioned way to raise one command's privileges after the user approves it
in a dialog the OS (or a trusted system program) shows. The agent should use that instead of
handing the work back.

## 2) Behavior

The model asks for administrator rights explicitly, per command, with `elevated: true` on the
shell tool (`bash` on Linux and macOS, `powershell` on Windows). It never writes `sudo` itself.

1. The tool shows a system dialog on the machine the agent runs on, naming the command.
2. The user approves it: types their password (Linux, macOS) or confirms the UAC prompt (Windows).
3. The command runs with administrator rights and its output comes back as usual.
4. Declined or unanswered: the command does not run, and the tool says so. The model is told not to
   retry the same command unless the user asks.

Every elevated command needs its own approval. One approval never covers a later command.

The password goes from the dialog to the system's elevation program and nowhere else: mistermorph's
agent process, the model, the tool output and the logs never see it.

## 3) Mechanisms

| OS | Tool | How it runs | Dialog |
| --- | --- | --- | --- |
| Linux | `bash` | `sudo -k -A -- bash -c <cmd>` | the system's pinentry, else a graphical pinentry (GNOME, Qt, GTK), `zenity` or `kdialog` |
| macOS | `bash` | `sudo -k -A -- bash -c <cmd>` | the native AppleScript dialog (`osascript`), with the password hidden |
| Windows | `powershell` | `Start-Process powershell -Verb RunAs` | the UAC consent (or credential) prompt |

### 3.1 Linux and macOS: sudo with an askpass helper

`sudo -A` runs the program named by `SUDO_ASKPASS` to read the password: the program prints it on
stdout. mistermorph is its own askpass program. The tool sets:

- `SUDO_ASKPASS` to the running mistermorph binary (`os.Executable()`);
- `MISTERMORPH_ASKPASS=1`, which makes that binary start in askpass mode instead of the CLI;
- `MISTERMORPH_ELEVATE_COMMAND`, the command shown in the dialog;
- `MISTERMORPH_ELEVATE_DIALOG`, a dialog program chosen in config, when there is one;
- the desktop session's display variables (`DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`,
  `DBUS_SESSION_BUS_ADDRESS`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`), so the dialog can show.
  These are passed only to elevated runs; ordinary commands keep their short environment.

In askpass mode the binary shows the dialog, prints what the user typed, and exits 0; it exits 1
when the user cancels. sudo reads the password from the pipe and checks it as usual.

The executable has to know it may be started that way: `elevate.HandleAskpass` at the start of
`main` runs the helper when `MISTERMORPH_ASKPASS=1` and otherwise marks the executable as able to
serve as one. The mistermorph CLI calls it. An embedding program calls
`integration.RunAskpassIfRequested`, which does the same; until it does, elevated commands are
unavailable on Linux and macOS, since sudo would otherwise start the host program again.

- **Linux dialog.** pinentry is the dialog GnuPG uses for passphrases and is installed on most
  desktops. The helper speaks pinentry's Assuan protocol (`SETTITLE`, `SETDESC`, `SETPROMPT`,
  `GETPIN`). It uses, in order: the dialog set in `tools.bash.elevation.dialog`; the program the system's
  `pinentry` points at (on Debian and Ubuntu, the `update-alternatives` choice), unless that is a
  terminal variant (`pinentry-curses`, `pinentry-tty`, `pinentry-emacs`), which cannot work without
  a terminal; `pinentry-gnome3`, `pinentry-qt` or `pinentry-gtk-2`; `zenity --entry --hide-text`;
  `kdialog --password`.
- **macOS dialog.** `osascript` with `display dialog … with hidden answer`. The command text is
  passed as an argument to the script, never spliced into it.
- **Why not `pkexec` or `with administrator privileges`.** `pkexec` drops the working directory and
  environment and needs a polkit agent; macOS's `do shell script … with administrator privileges`
  may reuse an earlier authorization for a few minutes, so one approval could cover later commands.
  sudo with `-k` asks every time on both.

### 3.2 No credential cache

After a successful `sudo`, sudo normally skips the password for a few minutes. Two things keep that
from letting the agent run later commands unasked:

- `-k` with a command makes sudo (and sudo-rs) ignore the cached record and authenticate.
- Each shell command runs in a new session (`Setsid`). sudo keys its records by terminal or
  session, so a record made for one command never matches the next.

### 3.3 Windows: UAC

`RunAs` starts an elevated process that cannot write to the caller's pipes, so the tool runs a short
wrapper script in the normal `powershell` process:

1. It starts `powershell.exe -NoProfile -NonInteractive -EncodedCommand <inner>` with
   `-Verb RunAs -Wait -PassThru`. Windows shows the UAC prompt for it.
2. The inner script changes to the working directory, runs the command with all output streams
   redirected to a temporary file, and exits with the command's exit code.
3. The wrapper prints the file, deletes it, and exits with the elevated process's exit code.

Declining the UAC prompt makes `Start-Process` fail with "The operation was canceled by the user".
The inner command is passed Base64-encoded (`-EncodedCommand`), so no quoting reaches it.

## 4) When it is offered

`elevated` is in the tool's schema when the tool's elevation is enabled
(`tools.bash.elevation.enabled` or `tools.powershell.elevation.enabled`, default
true) and the OS has a way to do it:

| OS | Available when |
| --- | --- |
| Linux | the executable handles askpass (section 3.1), `sudo` is installed, a display is set (`DISPLAY` or `WAYLAND_DISPLAY`), and a dialog program is found (or one is configured) |
| macOS | the executable handles askpass, `sudo` and `osascript` are installed |
| Windows | always (UAC needs an interactive session; a service gets an error from `Start-Process`) |

The dialog appears on the agent's machine. A run started from Telegram or another chat channel can
use it, but someone has to be at that machine; with nobody there the dialog times out and the tool
reports it. mistermorph never asks for a password in a chat message.

When elevation is unavailable, `elevated: true` fails with the reason ("no desktop session to show
an approval dialog on") and the command, so the model can hand it to the user as before.

## 5) Model guidance

- The parameter's description: use it only for a command that needs administrator rights, never
  prefix the command with `sudo`, keep the command to what needs the rights, and explain in the
  reply what it will change.
- A non-elevated command whose output shows sudo failing for want of a terminal or password gets a
  note appended: run it again without `sudo` and with `elevated: true`.

## 6) Timeout

The dialog wait counts against the command's timeout. An elevated command gets the tool's timeout
plus the tool's `elevation.approval_timeout` (2 minutes by default) for the user to answer. The askpass
helper closes its dialog when that time is up.

## 7) Config

Each shell tool has its own section, next to its other settings: `bash` elevates on Linux and macOS,
`powershell` on Windows, so the two never apply on the same machine.

```yaml
tools:
  bash:
    elevation:
      # Let bash commands ask for root through a system dialog (Linux, macOS).
      enabled: true
      # How long the dialog waits for the user, on top of the command's own timeout.
      approval_timeout: "2m"
      # The dialog program to use instead of the automatic choice
      # (a pinentry, zenity or kdialog binary).
      dialog: ""
  powershell:
    elevation:
      # Let powershell commands ask for administrator rights through UAC (Windows).
      enabled: true
      approval_timeout: "2m"
```

## 8) Audit

Each elevated command is logged (`elevated_command_started`, `elevated_command_finished`) with the
tool, the command, the exit code and whether the user declined. The password is never logged.

## 9) Limits

- Approval happens at the agent's machine only. From a Console opened on another computer, or a
  chat channel, nobody can answer the dialog; it times out and the command does not run.
- A user without administrator rights cannot approve anything; sudo or UAC refuses.
- A sudoers rule with `NOPASSWD` skips the password, and then the dialog does not appear: that is
  the administrator's choice.
- Commands run with root's environment (sudo resets it); `PATH` additions and injected variables of
  the shell tool do not reach them.
- Windows output arrives when the command ends, not as it runs.
- Headless servers have no dialog. A narrow `NOPASSWD` sudoers rule for specific commands is the
  way to let an agent run them there; the agent does not set that up.

## 10) Code and tests

- `internal/elevate`: the availability check, the sudo command line and environment, the askpass
  helper and its dialogs (pinentry over Assuan, zenity, kdialog, osascript), and the Windows
  `RunAsScript`. `cmd/mistermorph/main.go` starts the helper when `MISTERMORPH_ASKPASS=1`.
- `tools/builtin`: `elevated` on `bash` (Linux, macOS) and `powershell` (Windows), `runElevated`
  (logging, declined and timed-out approvals), and the sudo hint.
- `tools.bash.elevation` and `tools.powershell.elevation` in config defaults, the Settings field
  registry and the Console's `bash` and
  `powershell` settings. Embedded programs (`integration`) default it to off and turn it on with
  `integration.RunAskpassIfRequested` plus `tools.bash.elevation.enabled` (or the powershell one).

Verified:

- Linux: the bash tool against a fake `sudo` that calls the real askpass helper (approved, declined,
  wrong password), with fake dialogs; and the real `pinentry-gnome3` showing the dialog and timing
  out. A real `sudo` run needs a person to type the password.
- macOS and Windows: builds, and unit tests of the osascript arguments and the UAC script (decoded
  and checked; parsed by PowerShell when `pwsh` is installed). Not yet run on those systems.

