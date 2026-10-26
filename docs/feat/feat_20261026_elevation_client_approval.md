---
date: 2026-10-26
title: Elevated commands, approved from the Console or chat, with the password encrypted end to end
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

The Console is often reached over plain HTTP, through a LAN, a VPN or an SSH port forward without
TLS. So the password must not rely on the transport for secrecy: it is encrypted by the client and
decrypted only by the runtime that hands it to sudo.

## 2) Behavior

When the model runs a command with `elevated: true`, and the user is watching the task in the
Console or chat:

1. An approval card appears in the conversation. It shows the command, the working directory, the
   machine it runs on, a countdown and a masked password field, with **Allow** and **Decline**
   buttons.
2. **Allow** encrypts the password on the client and sends it. The command runs as root, and its
   output comes back as usual.
3. **Decline**, or no answer before the deadline, returns the base design's declined or timed-out
   result. The command does not run.
4. A wrong password: sudo asks again, up to its own limit (3 tries). Each try is a new card with a
   new key.
5. Afterwards the card shows the outcome (allowed, declined, expired, wrong password) and loses its
   field. The password is never shown, stored, logged, sent to the model or kept in the task result.

Every elevated command still needs its own approval (`sudo -k`, one session per command).

**In chat**, the card is a modal in the TUI: the command, a masked input, Enter to allow, Esc to
decline. Chat has two modes, and the modal looks the same in both:

- **Local** (the default): the agent runs inside the chat process. The modal is the run's approver
  directly, so the password never leaves the process and needs no encryption.
- **Attached to a runtime** (`--runtime-url`): chat reads the Console runtime's task stream like the
  web Console does, and seals the password the same way (§3.4), pinning the runtime's identity
  (§3.5).

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
  `declined`, `expired`, `rejected`), `web_insecure` (the policy, for the web card) and, only while
  open, `offer` (§3.4). The task result keeps `result.elevations` without offers.
- **Answer:** `POST /tasks/{id}/elevation` with `{elevation_id, decline: true, client}` or
  `{elevation_id, answer: {client_pub, nonce, ciphertext}, client}`, where `client` is `web`,
  `desktop` or `chat`. The response is `{accepted}`, false when the request is no longer open; a
  refused answer is a 400 with the reason. Any answer closes the request: one that does not decrypt
  closes it as `rejected`, and the command fails. The handler never logs the body.
- **Identity:** `GET /elevation/identity` returns `{identity, fingerprint}`.
- **Audit:** `elevated_command_approved`, `elevated_command_declined` and
  `elevated_command_answer_rejected` record the task, the elevation, the command, the client, the
  transport (`secure` or `insecure`) and the remote address. They never record the password.

### 3.4 Encryption

Each request uses fresh keys, so the runtime's ephemeral secret key exists only while the request is
open.

**Runtime identity.** Each runtime creates one long-term Ed25519 key, the *identity key*. It is
kept in `file_state_dir/elevation_identity` (`0600`) and created on first use. Its fingerprint is
the first 16 bytes of `SHA-256(public key)`, as 8 groups of 4 hex digits. The runtime logs it
(`elevation_identity fingerprint=…`) when it first loads the key, and `GET /elevation/identity`
returns it.

**Request (runtime → client), in the stream frame:**

| Field | Value |
| --- | --- |
| `v` | `1` |
| `server_pub` | a new X25519 public key for this request |
| `identity` | the identity public key |
| `signature` | Ed25519 over `context(server_pub)`, by the identity key |

`context(purpose, x)` is the byte string `"mistermorph-elevation-v1" ‖ len‖purpose ‖
len‖elevation_id ‖ len‖task_id ‖ SHA-256(command) ‖ SHA-256(cwd) ‖ deadline (Unix seconds, 8 bytes,
big-endian) ‖ x`, with each variable-length field prefixed by its 4-byte big-endian length, so
fields cannot run into each other. The purpose (`offer`, `key`, `answer`) keeps the signature, the
key derivation and the associated data apart. The signature is over `context("offer", server_pub)`.

**Answer (client → runtime):**

1. Check `signature` against the **pinned** identity (§3.5). If the check fails, refuse to send.
2. Make a new X25519 key pair, `client_pub` and `client_secret`.
3. `shared = X25519(client_secret, server_pub)`.
4. `key = HKDF-SHA256(ikm = shared, salt = server_pub ‖ client_pub, info = context("key", ""))`.
5. `ciphertext = XChaCha20-Poly1305(key, nonce = 24 random bytes, plaintext = password,
   aad = context("answer", client_pub))`.
6. Send `client_pub`, `nonce` and `ciphertext`, base64url without padding.

`internal/elevate/seal/testdata/vectors.json` pins the wire format with fixed keys; the Go and
JavaScript implementations are both tested against it.

**Runtime:** decrypt once. If decryption fails, the request closes as `rejected`; one that is
closed or past its deadline finds nothing open. The ephemeral secret key, the
derived key and the plaintext buffer are zeroed after use. The password goes from there to the
helper over the Unix socket, and from the helper to sudo, and nowhere else.

The associated data ties the ciphertext to one elevation of one task, with that exact command and
directory, before that deadline. So a captured answer cannot be replayed, and cannot be used for a
different command.

The bearer token and the Console login password are never used as key material: on plain HTTP they
cross the network in the clear.

**Libraries:** Go uses `crypto/ed25519`, `crypto/ecdh`, `crypto/hkdf` and
`golang.org/x/crypto/chacha20poly1305` (already a dependency). The web Console uses
`@noble/curves`, `@noble/ciphers` and `@noble/hashes`. Browsers disable `crypto.subtle` outside
secure contexts (HTTPS or localhost), so WebCrypto cannot be relied on.

### 3.5 Identity pinning

Encryption alone stops someone who only reads the traffic. Against someone who can also change it,
the client must know the runtime's real identity key, or the attacker could substitute its own
`server_pub`.

- **chat**: stores the identity per Console address in `known_runtimes` (like SSH's
  `known_hosts`), in its state directory.
  - First connection: chat shows the fingerprint and asks the user to confirm it against what
    `mistermorph console` printed. Local chat over loopback pins it without asking.
  - Changed key: chat refuses to send a password and says so, until the user removes the old entry
    (`mistermorph chat --forget-runtime <address>`).
- **Desktop app** (`desktop/wails`): pins like chat. Its pages are loaded from the app, not the
  network.
- **Web Console**: pins the identity in browser storage per origin and refuses on a change. It
  cannot defend against an attacker who changes the traffic, though: on plain HTTP that attacker can
  rewrite the page's own JavaScript. The card states this:
  - **HTTPS or localhost:** no note.
  - **Plain HTTP:** "Not on HTTPS: the password is encrypted against eavesdropping, but this page
    could be tampered with on the way. Use HTTPS, an SSH tunnel or chat for full protection."
  - `tools.bash.elevation.web_insecure: deny` hides the field on plain HTTP and tells the user to
    use HTTPS, a tunnel or chat instead. The default is `warn`.

**How the runtime knows the transport.** The browser talks to the Console server, which proxies to
the runtime, so the runtime sees only the proxy's hop. The proxy passes on how the browser's own
connection was made: on the request context when the runtime is in the same process, or in the
`X-MisterMorph-Client-Transport` and `X-MisterMorph-Client-Remote` headers when it is reached over
the network (`internal/daemonruntime/transport.go`). A connection is `secure` over TLS, from this
machine, or through a TLS-terminating proxy on this machine (`X-Forwarded-Proto: https` from a
loopback peer); everything else is `insecure`. A TLS proxy on another machine reads as `insecure`,
so with `deny` it is refused. The runtime enforces `deny` for answers marked `client: web`; the card
also hides its field on its own.

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

| Threat | Chat, desktop app | Web Console, HTTPS or localhost | Web Console, plain HTTP |
| --- | --- | --- | --- |
| Someone reads the traffic | protected | protected | protected |
| Someone changes the traffic | protected (pinned identity) | protected (TLS) | **not protected** (page can be rewritten) |
| Captured answer replayed | protected | protected | protected |
| Approval used for another command | protected | protected | protected |
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
      # The web Console on plain HTTP (not localhost): warn (show the card with a warning) or
      # deny (refuse, and point to HTTPS, an SSH tunnel or chat).
      web_insecure: "warn"
```

## 6) Limits

- An open approval is lost if the runtime restarts, like any running task. The command does not run.
- The web Console on plain HTTP is safe from eavesdropping only (§4).
- Whoever can use the Console can see approval cards. They still need the sudo password.
- Powershell's UAC prompt cannot be answered remotely. Windows keeps the base design.
- `mistermorph run` keeps the desktop dialog.
- The identity lives in `file_state_dir`. A new state directory means a new identity, and clients
  that pinned the old one refuse until the user checks the new fingerprint and trusts it.

## 7) Alternatives considered

- **TLS only.** This was rejected because it is not always there, which is the reason for this
  document.
- **Let sudo prompt on chat's terminal** (no `setsid`). This was rejected: sudo would write into the
  TUI and compete for keystrokes. It does nothing for the Console either.
- **Sign approvals instead of sending the password.** Each client device holds a key paired once
  over a trusted path. It signs (request, command hash, deadline), and a root helper allowed by a
  one-time sudoers rule checks the signature before running the command. No password ever crosses
  the network, and even plain-HTTP tampering can only block, not approve. It was set aside for now:
  it needs a root install and changes "sudo asks every time" into a standing grant to the helper.
  It remains the path if the web Console on plain HTTP must resist tampering.

## 8) Code and tests

- `internal/elevate`: the approval session, `Approver`, the thin-client helper, the `dialog`
  approver, `Offered` and `CheckContext`. Tests run the bash tool against a fake `sudo` (with sudo's
  three tries) that calls the real helper: allowed, declined, expired, wrong password then right,
  a wrong token, the session ending mid-ask, and the availability rules per approver mode.
- `internal/elevate/seal`: the identity and the protocol. Tests: round trip, single use, every
  bound field and the signature tampered with, and `testdata/vectors.json`.
- `internal/daemonruntime`: the routes and `RequestTransport`, tested for TLS, loopback, local
  proxies and relayed transports.
- `cmd/mistermorph/consolecmd/elevations.go`: cards, the registry, answers and the audit lines.
  Tests seal real answers against the cards: allowed, declined, unreadable, refused by `deny`,
  expired, another task's answer, and the identity kept across restarts.
- `web/console`: `core/elevation-seal.js` (tested against the Go vectors), `core/elevation-pins.js`
  (pins per runtime endpoint), `components/ChatElevationCard.js`, and the Settings fields.
- `cmd/mistermorph/chatcmd`: `prompt.go` (the card, shared by questions and approvals),
  `prompt_local.go` (the local approver and `ask_user`), `prompt_remote.go` and
  `known_runtimes.go` (frames, sealing, pinning in `file_state_dir/known_runtimes`,
  `--forget-runtime`). Tests drive the TUI, and an httptest runtime with a real identity checks the
  sealed password arrives and the pinning rules.

Chat attached with `--runtime-url` already requires HTTPS for a runtime on another machine, so the
fingerprint check there is on top of TLS; on loopback (or through an SSH tunnel) it pins silently.

Not verified: a real `sudo` with a person typing the password into the web card or the chat modal.
