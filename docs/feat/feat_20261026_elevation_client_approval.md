---
date: 2026-10-26
title: Elevated commands, approved from the Console or chat
status: implemented
---

# Elevated commands approved from a client

Extends `docs/feat/feat_20261024_elevated_commands.md` (the "base design" below).

## 1) Problem

The base design asks for the sudo password in a desktop dialog on the agent's machine. That fails
whenever the user is somewhere else:

- **Over SSH**, there is no display. Elevation is unavailable, or on macOS it fails inside
  `osascript`.
- **In a Console opened on another computer**, the dialog appears on a screen nobody is looking at
  and times out.
- **In `mistermorph chat` attached to a remote Console**, the same thing happens.

The user is at the Console or chat that started the task. That is where the approval should
appear.

The password goes from the client to the runtime over the client's own connection, and only that
connection protects it: HTTPS, loopback, an SSH tunnel or a VPN such as WireGuard. Only the client
can tell whether its connection is encrypted, so the web Console warns, across the top of every
page, while it is not.

## 2) Behavior

When the model runs a command with `elevated: true`, and the user is watching the task in the
Console or chat:

1. An approval card appears in the conversation. It shows the command, the working directory, the
   machine it runs on, a countdown and a masked password field, with **Allow** and **Decline**
   buttons.
2. **Allow** sends the password. The command runs as root, and its
   output comes back as usual.
3. **Decline**, or no answer before the deadline, returns the base design's declined or timed-out
   result. The command does not run.
4. A wrong password: sudo asks again, up to its own limit (3 tries). Each try is a new card.
5. Afterwards the card shows the outcome (allowed, declined, expired, wrong password) and loses its
   field. The password is never shown, stored, logged, sent to the model or kept in the task result.

Every elevated command still needs its own approval (`sudo -k`, one session per command).

**In chat**, the card is a modal in the TUI: the command, a masked input, Enter to allow, Esc to
decline. Chat has two modes, and the modal looks the same in both:

- **Local** (the default): the agent runs inside the chat process. The modal is the run's approver
  directly, so the password never leaves the process.
- **Attached to a runtime** (`--runtime-url`): chat reads the Console runtime's task stream like the
  web Console does, and sends the password the same way (§3.3). Chat already reaches a runtime on
  another machine only over HTTPS, so its connection is always encrypted or on loopback.

`mistermorph run` is out of scope: it keeps the desktop dialog.

## 3) Design

### 3.1 Overview

```
 bash tool ──sudo -k -A──▶ sudo ──SUDO_ASKPASS──▶ mistermorph (askpass mode)
     │                                                │ unix socket + token
     │ opens a session for the command                ▼
     └──────────────────────────────────────▶ approval session (runtime process)
                                                       │ approver chosen for this run
                              ┌────────────────────────┼─────────────────────┐
                              ▼                        ▼                     ▼
                       client approver           dialog approver       (none: unavailable)
                    (Console / chat card)     (base design's dialogs)
```

### 3.2 Approval session and askpass helper

The askpass helper stops opening dialogs itself. It becomes a thin client of an approval
**session** in the runtime process, one per elevated command (implemented: `internal/elevate/session.go`):

- Before starting sudo, the bash tool opens the session,
  `elevate.Begin(ctx, cfg, command, cwd, deadline)`. The session listens on a Unix socket in a new
  temporary directory only the runtime's user can open (`0700`), and makes a random token. The
  tool puts both in sudo's environment (`MISTERMORPH_ELEVATE_SOCKET`, `MISTERMORPH_ELEVATE_TOKEN`),
  next to the existing `MISTERMORPH_ELEVATE_COMMAND` and `MISTERMORPH_ELEVATE_DEADLINE`. When sudo
  returns, `End` closes the socket and removes the directory.
- sudo starts the helper. The helper connects, presents the token and waits. It receives either a
  password, which it prints for sudo, or a decline or timeout, which it reports with the existing
  `DeclinedMarker` and `TimedOutMarker`.
- The token is bound to one command and ends with it. A wrong-password retry (sudo starting the
  helper again) is allowed under the same token, up to 5 tries (sudo stops at its own limit, 3 by
  default), and each try is a new approval with `Request.Attempt` counting up.
- The token is not enough on its own. sudo runs the helper as the user, so any process of the user,
  such as another command the agent runs at the same time, can read the token from the helper's
  environment (`/proc/<pid>/environ`) and ask again, getting a "try again" card and the password
  typed into it. So the session answers only a direct child of the command's sudo process (the
  bash tool reports its pid with `Session.Started` once it starts), running as the user: the peer's
  pid and uid come from the socket (`SO_PEERCRED` on Linux, `LOCAL_PEERPID` and `LOCAL_PEERCRED` on
  macOS), and its parent from `/proc/<pid>/stat` or `kern.proc.pid`. Both sudo and sudo-rs start
  the askpass program as their own child. Any other connection is refused before the approver is
  asked.
- The session asks the **approver** the run's context carries (`elevate.WithApprover`). A runtime
  sets it the same way `WithUserQuestions` turns on `ask_user`. Without one, it asks in the desktop
  dialog.
- The helper closing its connection (sudo gave up), the command's context ending, or the deadline
  passing ends the ask.

The dialogs move behind the `dialog` approver unchanged. They now run in the runtime process,
which has the display variables, so sudo's environment no longer carries them (nor
`MISTERMORPH_ELEVATE_DIALOG`, which is gone). An external askpass program
(`tools.bash.elevation.askpass`) bypasses the session and still gets them.

### 3.3 Client approver: request and answer

It follows the `ask_user` cards (`docs/feat/feat_20261023_ask_user.md` §4.3): the request is shown
in the task's stream frame, and the approver waits for the answer. It does not go through the run
lease: the approval session already waits inside the tool call, and a message typed in the composer
must never answer it, unlike a question. The Console keeps its open approvals in one registry
across tasks (`cmd/mistermorph/consolecmd/elevations.go`):

- **Stream frame:** `elevations`, each with `id` (random), `command`, `cwd`, `host`, `deadline`
  (Unix seconds), `attempt` (2 and up after a wrong password), `status` (`open`, `allowed`,
  `declined`, `expired`, `rejected`). The task result keeps `result.elevations`.
- **Answer:** `POST /tasks/{id}/elevation` with `{elevation_id, decline: true, client}` or
  `{elevation_id, password, client}`, where `client` is `web`, `desktop` or `chat`, for the audit
  log only. The response is `{accepted}`, false when the request is no longer open; a refused answer
  is a 400 with the reason. Any answer closes the request: one without a password closes it as
  `rejected`, and the command fails. An answer that arrives as the request
  expires finds nothing open. The handler never logs the body.
- **Audit:** `elevated_command_approved`, `elevated_command_declined` and
  `elevated_command_answer_rejected` record the task, the elevation, the command, the client and
  the client's address. They never record the password. The Console passes the browser's address
  on to the runtime: on the request context when the runtime is in the same process, in the
  `X-MisterMorph-Client-Remote` header when it is reached over the network
  (`internal/daemonruntime/transport.go`).

### 3.4 Transport

The password crosses the client's connection as typed, inside the JSON body. The runtime then hands
it to the helper over the Unix socket, and the helper to sudo, and nowhere else.

**The runtime does not judge the connection.** It sees only its own hop, and that says little: a
TLS proxy in front of it, or a VPN such as WireGuard, arrives as plain HTTP, and a plain-HTTP proxy
on the same machine arrives as loopback. An earlier version classified each answer as `secure` or
`insecure` from that hop and could refuse insecure ones (`tools.bash.elevation.insecure: deny`).
It refused answers over a VPN and took answers through a plain-HTTP proxy, so it was removed. The
runtime takes any answer from a client that holds its bearer token.

**What the clients show.** The client knows how it reached its server. The web Console shows a
warning line across the top of every page, the login page included
(`components/AppInsecureBanner.js`), while the connection is not encrypted on either hop: the page
itself is on plain HTTP (`window.isSecureContext` false, outside the desktop app; a page on
`localhost`, such as one through an SSH tunnel, counts as secure), or the Console reaches the
selected endpoint, or the endpoint its chat submits to, over plain HTTP to another machine (the
endpoint's `url`). It says which hop is unencrypted (`insecureHops` in `core/endpoints.js`):
"This page is on plain HTTP, not HTTPS…", "The Console reaches the runtime at `<host>` over plain
HTTP…", or both, each ending with who can read what is sent unless an SSH tunnel or a VPN such as
WireGuard carries it. On a phone it drops the label and shows a shorter message. It is global
rather than on the card because the same holds for everything sent, the Console password first. It
does not block anything: on a VPN it does not apply, and only the person knows that. So it can be
closed, until the page reloads; it comes back when another hop turns unencrypted, such as after
switching to another endpoint. Chat needs no warning: it reaches a runtime on another
machine only over HTTPS.

**Why not encrypt in the client.** An earlier version sealed the password in the client to a
runtime identity key the client pinned. On plain HTTP that stops someone who only reads the
traffic, but someone who can change it can rewrite the web Console's JavaScript and read the
password before anything is sealed. Pinning in the browser fails the same way, because the
rewritten page shows whatever it likes. Where the client code does not come over the network
(chat, the desktop app), what needs protecting is the connection, which HTTPS or a VPN protects
without a key to manage or fingerprints to compare. So the sealing was removed.

### 3.6 Which approver

`tools.bash.elevation.approver: auto | client | dialog`, default `auto`:

| Value | Runs started from the Console chat or chat | Other runs (heartbeat, cron, channels) |
| --- | --- | --- |
| `auto` | client card | desktop dialog, if one can be shown |
| `client` | client card | unavailable |
| `dialog` | desktop dialog | desktop dialog |

"Started from the Console chat or chat" is the same test `ask_user` uses: the trigger
`{source: "ui", ref: "web/console/chat"}`, or `ref: "cli/chat"` from chat attached with
`--runtime-url`; a local chat session sets its approver itself. The `elevated` parameter is offered
when the process can approve at all: it asks clients (`elevate.OfferClientApprovals`, called by the
Console runtime and local chat) and sudo is there, or a dialog is available. A run with no approver
then gets the base design's "unavailable" error, with the reason (`elevate.CheckContext`).

Telegram, Slack and the other channels never take a password in a message. With `auto`, they keep
the desktop dialog. The tool's error can point the user to the Console.

## 4) Security properties

| Threat | Chat, desktop app, web Console on HTTPS or localhost | Web Console over a VPN or SSH tunnel | Web Console on plain HTTP over an open network |
| --- | --- | --- | --- |
| Someone reads the traffic | protected (TLS or loopback) | protected by the VPN or tunnel | **not protected**: the Console warns |
| Someone changes the traffic | protected | protected by the VPN or tunnel | **not protected** |
| Approval used for another command | protected: each card is one command, answered once | protected | protected |
| Password in logs, model, task history | never | never | never |
| Someone blocks or declines requests | possible: the command does not run | possible | possible |

## 5) Config

```yaml
tools:
  bash:
    elevation:
      enabled: true
      approval_timeout: "2m"
      dialog: ""
      askpass: ""
      # Where the approval is asked: auto (the Console or chat that started the task, else the
      # desktop dialog), client (only there), or dialog (only the desktop dialog).
      approver: "auto"
```

## 6) Limits

- An open approval is lost if the runtime restarts, like any running task. The command does not run.
- The password is only as safe as the connection (§4). The runtime cannot enforce HTTPS: the Console
  warns, and the person decides.
- Whoever can use the Console can see approval cards. They still need the sudo password.
- Powershell's UAC prompt cannot be answered remotely. Windows keeps the base design.
- `mistermorph run` keeps the desktop dialog.

## 7) Alternatives considered

- **Encrypt in the client, to a pinned runtime key.** Built first, then removed (§3.4): it does not
  survive a rewritten page on plain HTTP, and HTTPS or a VPN gives the same protection elsewhere.
- **Let sudo prompt on chat's terminal** (no `setsid`). This was rejected: sudo would write into the
  TUI and compete for keystrokes. It does nothing for the Console either.
- **Sign approvals instead of sending the password.** Each client device holds a key paired once
  over a trusted path. It signs (request, command hash, deadline), and a root helper allowed by a
  one-time sudoers rule checks the signature before running the command. No password ever crosses
  the network, and even plain-HTTP tampering can only block, not approve. It was set aside for now:
  it needs a root install and changes "sudo asks every time" into a standing grant to the helper.
  It remains the path if the web Console on plain HTTP must resist eavesdropping and tampering.

## 8) Code and tests

- `internal/elevate`: the approval session, `Approver`, the thin-client helper, the `dialog`
  approver, `Offered` and `CheckContext`. Tests run the bash tool against a fake `sudo` (with sudo's
  three tries) that calls the real helper: allowed, declined, expired, wrong password then right,
  a wrong token, a process with the token that is not sudo's child, an ask before sudo started,
  the session ending mid-ask, and the availability rules per approver mode.
- `internal/daemonruntime`: the routes and `RequestRemote`, tested for direct, local-proxy and
  relayed clients.
- `cmd/mistermorph/consolecmd/elevations.go`: cards, the registry, answers and the audit lines.
  Tests: allowed, declined, no password, expired, an answer after expiry, and another task's
  answer.
- `web/console`: `components/ChatElevationCard.js`, `components/AppInsecureBanner.js` and
  `core/endpoints.js` (`connectionInsecure` and `endpointURLInsecure`, tested), and the Settings
  fields.
- `cmd/mistermorph/chatcmd`: `prompt.go` (the card, shared by questions and approvals),
  `prompt_local.go` (the local approver and `ask_user`) and `prompt_remote.go` (frames and
  answers). Tests drive the TUI, and an httptest runtime checks that the password arrives.

Not verified: a real `sudo` with a person typing the password into the web card or the chat modal.
