---
branch: factory/FT191-desktop-network-proxy
round: 1
---
# Desktop: a network proxy setting (HTTP and SOCKS5) for the app's own requests

## factory · 2026-11-27 01:06

Recorded from the owner's request to put this in new.

### What the user asked for

- An entry in the desktop app's settings that opens a dialog for a network proxy.
- HTTP proxy and SOCKS5 to start with.
- Every external network request the desktop app makes itself, where it can be supported, goes through the chosen proxy.

Everything below this heading is the manager's reading of the code and the decisions that follow from it, not the user's words.

### Summary of the build

One setting owned by the desktop shell (`desktop/nsh`), read once at launch and turned into the standard proxy variables: one set for the desktop process, one for the backend it starts.

- Three changes make that hold for the app's clients: ureq's SOCKS support is switched on, the desktop's loopback requests never use a proxy, and the core's `url_fetch` becomes proxy-aware: under a required proxy it goes through the proxy or refuses, and never connects direct.
- No security guard is overridden. Under the default guard settings `url_fetch` is refused while an explicit proxy is running; the owner can permit it with two existing settings.
- A changed setting applies when the user quits and reopens the app.
- A saved explicit proxy that cannot be loaded blocks the start instead of falling back to a direct connection.

Not a proxy layer, not traffic interception, no per-client proxy options in the core, no automatic relaunch.

### Today (source: `origin/master` at `098d31de`)

- The desktop starts `morph console serve` with its own environment (`desktop/nsh/src/backend.rs:58-62`, `child_env` at `:219-226`). There is no proxy setting anywhere in the app.
- Go core: nearly every client uses the default transport or gorilla's default dialer, which read `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (upper case first) and never proxy `localhost`, `127.0.0.1`, `::1`. They do not read `ALL_PROXY`. Examples: `tools/builtin/web_search.go:115`, `internal/mcphost/host.go:231-241`, `internal/channelruntime/slack/slack_api.go:456`, `internal/discordapi/gateway.go:149`, `internal/agentlink/conn.go:144`, `cmd/mistermorph/consolecmd/daemon_client.go:28-34`, `internal/updatecheck/updatecheck.go:219`; LLM calls through uniai and openai-go use `http.DefaultClient`.
- Go core, the exception: `url_fetch` sets `Proxy = nil` when the guard's or the auth profile's `allow_proxy` is false, and again, with a dialer that checks the resolved addresses, when `deny_private_ips` is true (`tools/builtin/url_fetch.go:393-395`, `:415-417`, `:724-765`; `guard/url_policy.go:11`, `:66`). `allow_proxy=false` and `deny_private_ips=true` are the defaults (`internal/configdefaults/defaults.go:253-255`), so `url_fetch` connects direct whatever the environment says.
- gorilla/websocket 1.5.3 accepts `http://` and `socks5://` proxies and rejects `socks5h://`. Go's `net/http` lets the proxy resolve names for `socks5://` too.
- Desktop shell: all its requests come from one builder, `desktop/nsh/src/http.rs:9-16` (ureq 3.5.1, proxy from the environment): the health check (`src/backend.rs:83-102`), the `auto_update` read (`src/config.rs:99-103`), uploads and saves (`src/files.rs:310`, `:352`), the update check and download (`src/update.rs:214`, `:265`), the backend download (`src/backend.rs:406`).
- Console inside the desktop: nsh's `fetch` and image loader use process-wide ureq agents built from the environment on first use (nsh-engine 0.6.0 `src/net.rs:37-70`, nsh-core 0.6.0 `src/image/loader.rs:1042-1059`); the embedder cannot replace them (`desktop/nsh/vendor/nsh-platform-gpui/src/app.rs:1100`). nsh's WebSocket connects TCP itself and knows no proxy (nsh-core 0.6.0 `src/runtime/websocket/native.rs:276-293`). On the desktop the Console talks to `http://127.0.0.1:<port>` only (`src/host.rs:112-122`; the server picker is mobile-only, `web/console-nsh/pages/login/LoginPage.tsx:55`), except for the skill store's `SKILL.md` preview (`pages/skills/SkillStorePage.tsx:135`) and remote images such as the credits avatars (`components/settings/SettingsCreditsPanel.tsx:31`).
- ureq 3.5.1, probed as a standalone crate: loopback targets are sent to the proxy unless `NO_PROXY` names them, and `::1` only matches written as `[::1]`; it takes the first of `ALL_PROXY`, `HTTPS_PROXY`, `HTTP_PROXY` (upper case before lower) for every URL, and `NO_PROXY` before `no_proxy`; `socks5://` resolves names locally, `socks5h://` at the proxy. Built without its `socks-proxy` feature, a `socks5://` proxy from the environment is ignored and the request goes direct.
- Suspected, not confirmed: the desktop builds ureq without `socks-proxy`. No manifest enables it (`desktop/nsh/Cargo.toml` has `ureq = "3"`; nsh-core and nsh-engine ask for `platform-verifier` only), but the app's resolved feature set was not read.
- Agent subprocesses: the bash and PowerShell tools and the coder CLIs get an allowlisted environment without proxy variables unless they are listed in `tools.bash.injected_env_vars` / `tools.powershell.injected_env_vars` (FT131; `internal/shellenv/tool_env.go:12-29`, `:75-102`). MCP stdio servers get the core's whole environment (`internal/mcphost/host.go:211-217`). A coder session is reused per scope and backend without comparing its environment (`internal/codersessions/sessions.go:17`, `:44`).
- The backend's output reaches the desktop log in 8 KB chunks (`src/backend.rs:153-167`). The startup error view is native, with Restart, Open Log, Copy Diagnostics and Quit (`src/shell.rs:296-330`).
- There is no WebView and no nsh updater in the desktop build, and the desktop never attaches to a remote core.

The behaviours of Go, gorilla and ureq above were checked with throwaway probes against fake proxies; the desktop app itself was not built or run.

### Scope

In:

- `desktop/nsh`: the saved setting, its host calls, the launch-time environments, the HTTP agents, the blocked-start view, the log redaction, `Cargo.toml` (ureq's `socks-proxy` feature and a credential store crate).
- `web/console-nsh`: the settings entry and dialog, shown only when the host has the feature; strings in every locale the Console has.
- Go core: `url_fetch` under a required proxy. Nothing else in the core changes; no guard default, config key or subprocess environment changes.
- Docs in English: `desktop/nsh/README.md` (files, host contract), `docs/tools.md` and `docs/security.md` where they describe `url_fetch`, `allow_proxy` and `deny_private_ips`, and the guide page that covers the desktop app if one does.

Out: see Non-goals.

### The setting

Two modes:

- **System default** (the default, and what "restore default" means): the app follows the proxy variables it inherited. Nothing the app does in explicit mode is written to the user's shell, system or config files, so returning to this mode needs nothing undone.
- **Explicit proxy**: type `HTTP` or `SOCKS5`, host, port, optional user name and password.

Validation, on save, each error tied to its field:

- Host: required; a host name, an IPv4 address or an IPv6 address (with or without brackets); no scheme, path, user info, port or white space.
- Port: required, an integer from 1 to 65535.
- User name: optional; no `:` and no control characters; at most 255 bytes.
- Password: allowed only with a user name; no control characters; at most 255 bytes. A user name with an empty password is valid.
- A setting that fails validation is not saved and changes nothing.

Persistence:

- Mode, type, host, port, user name and whether a password is stored, in `<config>/mistermorph/desktop/network-proxy.json`, written atomically like the other desktop files (`paths::write_atomic`).
- The password in the OS credential store (macOS Keychain, Windows Credential Manager, Secret Service on Linux), never in that file, `kv.json`, the backend's config or `agent.db`.
- No credential store available: saving a setting with a password fails with a message that says so. There is no plaintext fallback. A proxy without a password saves as usual.
- Switching to System default keeps the saved fields and the stored password, so the proxy can be switched back on; a "clear" action in the dialog removes the stored password.

### What the app does at launch

Before any thread starts (`main`, ahead of the update check, the backend and the window), the shell does three things in order.

1. It keeps the environment it inherited as an untouched snapshot. Every backend environment is built from this snapshot, never from the process's later state.
2. It loads the saved setting into one of three states: System default, explicit, or blocked.
3. It sets its own process's proxy variables for that state. They are not changed again while the process lives.

Which state:

- No settings file: System default. This is first use.
- A file that says System default: System default.
- A file that says explicit, passes validation, and whose password (when the file says one is stored) is read from the credential store: explicit.
- Anything else is **blocked**: a file that cannot be read or parsed, fields that fail validation, a stored password that is missing or cannot be read. The app must not treat any of these as System default.

System default:

- The backend gets the inherited snapshot exactly, as today (after `child_env`'s AppImage filter). Nothing is added, removed or rewritten.
- The desktop process changes one thing, and only when a proxy variable is inherited: its bypass list gains `localhost,127.0.0.1,::1,[::1]`. The list extended is the one its client reads today, `NO_PROXY` when set, else `no_proxy`; it is written back under that same name (or `NO_PROXY` when neither was set), and the other-case variable is left alone. Existing entries, including `*`, are kept.

Explicit proxy:

- The eight standard names are taken over: `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lower-case forms. Inherited values of these names, in either case, are dropped; the explicit setting wins over all of them. This includes an inherited `NO_PROXY`: the only bypass in explicit mode is loopback.
- `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and the lower-case forms all get the same proxy URL, so that a client preferring either case, or `ALL_PROXY`, reaches the same proxy. (On Windows the two cases are one variable.)
- The backend gets `http://[user:password@]host:port` or `socks5://[user:password@]host:port`. Never `socks5h://`: gorilla rejects it, and Go resolves names at the proxy for `socks5://`.
- The desktop process gets the same URL for HTTP and `socks5h://…` for SOCKS5, so that ureq resolves names at the proxy. This form never reaches the backend.
- User name and password are percent-encoded in the URL; an IPv6 host is bracketed.
- `NO_PROXY` / `no_proxy`: `localhost,127.0.0.1,::1,[::1]`.
- `REQUEST_METHOD` is removed from the backend's environment (Go refuses `HTTP_PROXY` when it is set).
- The backend also gets one marker variable meaning "a proxy is required" (name for the build to settle, e.g. `MISTER_MORPH_DESKTOP_PROXY_REQUIRED=1`). It is not a config key and not a setting the Console shows.
- Every other inherited variable passes as it does today.

Blocked:

- The backend is not started. The update check, the backend download and the Console are not started either. The app makes no external request.
- The window shows a native view in the style of the startup error view. It says that the saved network proxy could not be loaded and why (unreadable file, invalid field, password not available), with the type, host and port when they are known and never a credential.
- Its actions: **Quit**, **Open Log**, and **Switch to System default and quit**. The last one says, before it acts, that the app will then connect without the saved proxy; it writes System default to the settings file (keeping the readable fields and the stored password) and quits. The user reopens the app.
- Repairing without leaving explicit mode is done outside the app (for example unlocking the credential store), then reopening. A password that is gone can only be entered again in the dialog, after switching to System default; the view says so.
- `MrMorph --check-update` in this state prints the same reason and exits with a failure, without a request.

All states:

- The shell's requests to the backend (health check, `auto_update` read, uploads and saves to the backend's origin) use an agent with no proxy, chosen by the target being loopback, not by `NO_PROXY`.
- ureq is built with `socks-proxy`, so that a SOCKS proxy is used or the request fails. First confirm the suspicion with `cargo tree -e features -i ureq` in `desktop/nsh`, before and after. If confirmed, this also changes System default: an inherited `socks5://` variable, ignored today, is honored by the shell's and the Console's requests.
- The backend restart the app already has (`morph.desktop.restart`, the startup error view's Restart) starts the backend with the same state and the same snapshot. It does not pick up a changed setting.

Recovery when an explicit proxy is running and the start fails (for example the backend download cannot get through): the existing startup error view names the running proxy by type, host and port, and offers the same **Switch to System default and quit**. No environment variable or command-line switch is added for this.

### Core: `url_fetch` when a proxy is required

The marker changes how `url_fetch` picks its route. It does not change, read past, or relax any guard or auth profile setting.

Without the marker `url_fetch` behaves exactly as today.

With the marker, for every request and every redirect hop to a destination that is not loopback:

- **The route is the proxy or nothing.** The transport never has its proxy removed and never dials the destination itself.
- **`allow_proxy` is honored.** When the guard is on and `guard.network.url_fetch.allow_proxy` is false, or the request uses an auth profile whose `allow_proxy` is false, the request is refused before anything is sent. The error says that the desktop requires a network proxy and names the setting that forbids `url_fetch` from using one.
- **`deny_private_ips` is honored.** When it is true and the destination is a host name, the request is refused: the proxy would resolve the name, so the resolved address cannot be checked, and the name must not be resolved locally to get around that. The error names `deny_private_ips` as incompatible with the required proxy for host names. When the destination is an IP literal, it is checked as today and, if allowed, sent through the proxy.
- **Everything else stays**: allowed URL prefixes, the literal `localhost` and private-address checks, redirect rules, auth profile URL rules, on the first request and on every hop.
- A request that is allowed but cannot get through the proxy fails with an error naming the proxy's type, host and port and no credentials.

Loopback destinations are not proxied by Go; for them the existing checks apply unchanged.

What an owner who wants `url_fetch` to reach host names through the proxy has to set, by hand, and the docs say so:

- `guard.network.url_fetch.allow_proxy: true`
- `guard.network.url_fetch.deny_private_ips: false`
- for requests with an auth profile, that profile's `allow_proxy: true`

Nothing sets these automatically, and `docs/security.md` says what turning `deny_private_ips` off gives up.

### The Console: entry and dialog

- The host lists a new feature, `networkProxy`. The entry shows only when `hasFeature("networkProxy")` is true, so not in the browser or the phone app.
- Place: a "Network proxy" row in the app's settings panel (`web/console-nsh/components/settings/SettingsAppPanel.tsx`). The row shows the running state: "System default", or the type with `host:port`; plus "Quit and reopen to apply" when the saved setting differs from the running one.
- The row opens a dialog built from the existing dialog and field components: a choice of System default / HTTP / SOCKS5; host, port, user name, password (the secret input). The fields are disabled under System default.
- The password is write-only: the host tells the Console only whether one is stored. Leaving the field untouched keeps it; there is a way to clear it.
- A short note in the dialog states what goes through the proxy, what does not, and what is blocked (see Boundaries), in plain words. It does not say that all traffic is proxied.
- Save stores the setting and nothing else: no restart, no interruption. The running app and its tasks keep the route they started with.
- After a save that changes the setting, the dialog says that the setting applies after quitting and reopening the app, and that quitting stops running tasks. It offers **Quit now** and **Later**. "Quit now" asks for confirmation, repeats that running tasks will be stopped, and then quits through the existing `morph.desktop.quit`. "Later" closes the dialog and leaves the process as it is.
- The app does not reopen itself. No relaunch or restart call is added.
- Saving the values that are already running clears the pending state.

Host calls (names for the build to settle, kept in `web/console-nsh/lib/platform.ts` and `desktop/nsh/src/host.rs` like the others):

- get: the saved setting without the password (`hasPassword`), the running state (mode, type, host, port, user name), `pending`, and whether a credential store is available.
- set: the fields; rejects with per-field validation errors, or with the credential store's failure.

### Secrets and logs

- The app never formats the password into a message. Wherever a proxy is named (log lines, the row, errors, diagnostics, the blocked view, host call results), the text is built from type, host and port, with the user name at most, never from the proxy URL.
- The backend's output is copied into `desktop.log` in chunks, so a secret can be split across two reads. In explicit mode with a password, the shell redacts on whole lines, carrying an unfinished line over to the next read, and replaces each of these forms: the password as typed, its percent-encoded form, the `user:password@` part of a proxy URL, and the value of a `Proxy-Authorization` header (the Base64 of `user:password`). The same filter runs over text that goes into the startup diagnostics.
- This filter is a second line of defense for known forms. It does not make arbitrary backend output safe; the docs do not claim that it does.
- Security boundaries, to be written in the dialog's note and the docs as such:
  - While an explicit proxy with a password is running, the backend's environment contains the proxy URL with that password. Other processes of the same user can read it.
  - MCP stdio servers are started with the backend's whole environment and so receive it.
- The existing subprocess protections stay as they are: the bash and PowerShell tools and the coder CLIs get neither the proxy variables nor the marker unless the owner lists a name in `injected_env_vars`. This item adds nothing to their allowlists.

### Boundaries to state in the UI note and the docs

Through the proxy, when an explicit proxy is running: the core's HTTP, SSE and WebSocket requests (LLM providers, channels, `web_search`, MCP over HTTP, updates, skill installs, sign-ins, remote endpoints); the desktop shell's update check and downloads; the Console's own external requests (skill previews, remote images).

Blocked rather than proxied:

- `url_fetch`, under the default guard settings, and whenever `allow_proxy` is false or `deny_private_ips` is true for a host name. It fails with a policy error until the owner changes those settings.

Not through the proxy, and not claimed:

- Commands the agent runs (bash, PowerShell) and the coder CLIs (Codex, Claude Code, Antigravity) do not receive the proxy variables. Listing the names in `tools.bash.injected_env_vars` (`tools.powershell.injected_env_vars` on Windows) passes the app's values, password included, to them; whether a program honors them is that program's matter. A coder session keeps the environment it started with.
- MCP stdio servers receive the variables; honoring them is theirs.
- Links open in the system browser, which uses the system's settings.
- The Console's WebSocket has no proxy support; on the desktop it only connects to the app's own backend on loopback.
- Requests to `localhost`, `127.0.0.1` and `::1` never use the proxy.
- An HTTP proxy must allow `CONNECT` to the ports in use: the desktop's client tunnels plain `http://` requests too.

### Non-goals

- System-wide or transparent interception, PAC files, reading the OS proxy settings, per-host rules, a user-editable bypass list.
- HTTPS-scheme proxies, SOCKS4, NTLM or Kerberos.
- A "direct, ignore the environment" mode.
- Automatic relaunch, an in-app restart that applies the setting, an escape-hatch variable or flag.
- Entering or repairing the proxy from the blocked view.
- A "test connection" button.
- Changing guard defaults, overriding `allow_proxy`, or making `deny_private_ips` work for proxied host names.
- Passing the proxy to agent commands and coder CLIs automatically, or restarting coder sessions when their environment changes.
- Keeping the proxy password out of the backend's environment.
- Proxy settings for the browser Console, the phone app, or a core started from the CLI. Those keep following their environment.

### Acceptance criteria

Tests use fake HTTP and SOCKS5 proxies on loopback that record what they are asked for, a throwaway `HOME` given as an absolute path, and no real proxy or credentials. Go reads the proxy environment once per process, so environment cases run in a child process or against the function that builds the environment.

1. With no settings file, the backend's environment is the inherited one, unchanged. The desktop process's differs only by the loopback names added to its bypass list, and only when a proxy variable was inherited.
2. With an explicit setting, the backend's environment has the eight names set as specified, inherited values of those names gone (both cases, `NO_PROXY` included), `REQUEST_METHOD` gone, the marker present, and every other inherited variable unchanged. It contains no `socks5h://` value.
3. After returning to System default, quitting and reopening, criterion 1 holds again: the backend's eight names are byte for byte what the app inherited.
4. A saved explicit setting that cannot be loaded never results in a started backend or an external request. Only "Switch to System default and quit" followed by a reopen, or a repair followed by a reopen, gets the app running.
5. The dialog saves, validates, shows pending, and never receives the stored password.
6. Save alone starts or stops no process. A task running across a save finishes on the old route. "Later" leaves the process untouched; "Quit now" confirms first.
7. Under a required proxy, `url_fetch` never connects direct to a non-loopback destination, and no guard or auth profile setting is read differently than without the marker except to refuse.
8. The regression matrix below passes.
9. `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passes; `cargo test` in `desktop/nsh` passes; `nsh check` and `web/console-nsh/scripts/test.sh` pass.
10. The build report gives the `cargo tree -e features -i ureq` result before and after, and lists what was not checked on a real macOS, Windows and Linux desktop, and with a real proxy.

### Regression matrix

| # | Area | Case | Expected |
| --- | --- | --- | --- |
| 1 | HTTP proxy | Core client requests `http://name/` | The proxy receives the absolute-form request; the name is not resolved locally |
| 2 | CONNECT | Core client requests `https://name/` | The proxy receives `CONNECT name:443` |
| 3 | SOCKS5 | Core client requests `http://` and `https://` names | The proxy receives the domain name (ATYP 3), not an address |
| 4 | Proxy-side DNS | Desktop client through SOCKS5, a name that does not resolve locally | The proxy receives the domain name; no local lookup error |
| 5 | Auth, HTTP | User and password with `@`, `:`, `%`, space | `Proxy-Authorization: Basic` decodes to the exact pair, from the core and from the desktop client |
| 6 | Auth, SOCKS5 | User and password set | Method 2 with the exact pair, from the core, gorilla and the desktop client |
| 7 | Redaction, forms | A sentinel password; the backend writes it raw, percent-encoded, inside a proxy URL, and as a `Proxy-Authorization: Basic` value | None of the four forms is in `desktop.log` or the diagnostics |
| 8 | Redaction, chunks | The backend writes a line holding the sentinel in two writes split inside the secret, and a line longer than one read | The sentinel is not in `desktop.log` |
| 9 | Redaction, errors | A request fails at the proxy; a save fails; the start is blocked | No credential in the Console's error, the host call's result, the blocked view or the log |
| 10 | Storage | Save with a password | `network-proxy.json` has no password; the credential store has it; without a store the save fails and nothing is written |
| 11 | Env names and case | Inherited `http_proxy`, `HTTPS_PROXY`, `all_proxy` pointing elsewhere; explicit setting active | Every one of the six proxy names, both cases, carries the explicit URL in both environments |
| 12 | `ALL_PROXY` | Explicit setting active | Core clients (which ignore `ALL_PROXY`) and the desktop client (which prefers it) reach the same proxy |
| 13 | `NO_PROXY` precedence | Inherited `NO_PROXY=*` or a host list; explicit setting active | A listed external host still goes through the proxy; only loopback bypasses |
| 14 | Default mode, backend | Inherited `HTTP_PROXY`, `https_proxy`, `ALL_PROXY=socks5://…`, `NO_PROXY=example.com`, `no_proxy=other.test` | The backend's environment has exactly these values; no loopback names added, no `socks5h://` |
| 15 | Default mode, app bypass | The same inherited values | The desktop process's `NO_PROXY` is `example.com` plus the loopback names; `no_proxy` is still `other.test` |
| 16 | Default mode, lower case only | Inherited `http_proxy` and `no_proxy=other.test`, no upper-case forms | The desktop process's `no_proxy` gains the loopback names; no `NO_PROXY` appears; the backend's is unchanged |
| 17 | Default mode, no proxy | No proxy variable inherited | Neither environment gains any of the eight names |
| 18 | CGI edge | `REQUEST_METHOD` inherited; explicit HTTP proxy | The backend's plain-HTTP requests use the proxy |
| 19 | Loopback IPv4 | Health check, `auto_update` read, Console `fetch` to `127.0.0.1:<port>`; proxy set, in both modes | The fake proxy receives nothing; the app starts and logs in |
| 20 | Loopback IPv6 and name | Desktop client to `http://[::1]:<port>` and `http://localhost:<port>`; core client to the same | No request at the proxy |
| 21 | No fallback, dead proxy | Proxy port closed; target on a non-loopback address of the machine that answers direct | Error; the target records no connection. For the core's HTTP client, a gorilla dial, the desktop client, HTTP and SOCKS5 |
| 22 | No fallback, refusing proxy | Proxy answers 502 / SOCKS failure | The response or error is surfaced; the target records no connection |
| 23 | SOCKS in the desktop client | `socks5://` inherited in System default | Used, or an error; never a direct connection |
| 24 | SSE / streaming | A streamed LLM response and an MCP SSE stream through the HTTP proxy | The stream arrives through the proxy's connection and stays open |
| 25 | WebSocket | gorilla dial to `ws://` and `wss://` through HTTP and SOCKS5 | `CONNECT` / SOCKS request for the name |
| 26 | `url_fetch`, defaults | Marker set; default guard settings; a host name URL; a target that answers direct | Refused with the policy error; nothing at the proxy, nothing at the target |
| 27 | `url_fetch`, `allow_proxy` false only | Marker set; `deny_private_ips: false`, `allow_proxy: false` | Refused, naming `allow_proxy`; no connection anywhere |
| 28 | `url_fetch`, `deny_private_ips` true only | Marker set; `allow_proxy: true`, `deny_private_ips: true` | Host name: refused, naming `deny_private_ips`, no local lookup, no connection. Private IP literal: refused as today. Allowed IP literal: sent through the proxy |
| 29 | `url_fetch`, permitted | Marker set; `allow_proxy: true`, `deny_private_ips: false` | The request succeeds through the proxy; the target sees only the proxy; prefix and redirect rules still apply |
| 30 | `url_fetch`, auth profile | Marker set; guard permits; the profile's `allow_proxy` false, then true | Refused naming the profile; then through the proxy with the profile's URL rules applied |
| 31 | `url_fetch`, redirect | Marker set; permitted first hop; a redirect that the guard forbids, and one to a host name while `deny_private_ips` is true | Refused at the hop; no direct connection |
| 32 | `url_fetch`, dead proxy | Marker set; permitted; proxy port closed | Error naming the proxy's host and port; the target records no connection |
| 33 | `url_fetch`, no marker | `allow_proxy=false`, `deny_private_ips=true` | Exactly today's behaviour, direct with the resolved-address check |
| 34 | Console external requests | Skill store preview and a remote image; explicit setting running | Both at the proxy; with the proxy dead both fail, neither connects direct |
| 35 | Console WebSocket | Task stream with an explicit setting running | Connects to the loopback backend; nothing at the proxy |
| 36 | Save | Change the setting during a running task | No process starts or stops; the task completes; the row shows "Quit and reopen to apply" |
| 37 | Apply | "Quit now", confirm, reopen by hand | The confirmation names running tasks being stopped; the reopened app runs the new setting and shows no pending mark |
| 38 | Later | "Later", then the existing backend restart | The process and the backend keep the running state; the setting is still pending |
| 39 | Disable | Explicit to System default, quit, reopen | Rows 14 to 17 hold again; the saved fields and stored password remain until cleared |
| 40 | First use | No settings file | System default; no blocked view |
| 41 | Blocked, file | Explicit setting saved, then the file made unparseable; and a file with an invalid port | Blocked view; no backend process; no connection at the proxy or at a direct target; no update check |
| 42 | Blocked, credential | Explicit setting with a stored password; the entry removed from the store, and the store unavailable | The same as 41 |
| 43 | Blocked, choose default | "Switch to System default and quit", reopen | The view warned first; the app starts in System default; the fields that were readable are still in the dialog |
| 44 | Blocked, repair | The credential restored outside the app, reopen | The app starts with the explicit proxy |
| 45 | Start fails under a proxy | Explicit proxy running; the backend cannot start | The startup error view names type, host and port and offers "Switch to System default and quit" |
| 46 | Validation | Empty host, `http://host`, `host:80`, port 0 and 65536, user with `:`, password without user, 256-byte user | Each refused on its field; nothing saved |
| 47 | Subprocess allowlist | Explicit setting running; bash tool runs `env` | No proxy variable and no marker; with the names in `injected_env_vars`, the explicit values |
| 48 | Coder environment | A fake coder CLI with and without the names injected | Same as 47 |
| 49 | Session reuse | A coder session started before the names were injected | Keeps its startup environment; documented, not changed |
| 50 | MCP stdio | A fake stdio server prints its environment | Has the proxy variables; documented as a boundary |

### Not verified at intake, for the build to check

- The desktop app was not built here. ureq's resolved features are unknown: run `cargo tree -e features -i ureq` in `desktop/nsh` to confirm that `socks-proxy` is off today, and that enabling it in `desktop/nsh/Cargo.toml` turns it on for nsh-core's and nsh-engine's use as well (the lock file has one ureq).
- The credential store crate: that it builds with the pinned toolchain on the three platforms, and its behaviour on Linux without a Secret Service.
- Windows, where variable names are case-insensitive, and macOS.
- Whether chat Markdown can show remote images; if it can, row 34 covers them through the same loader.
- Whether any backend log line prints its environment or a proxy URL.

## factory · plan · 2026-11-27 01:54

### Behaviour
Capture the inherited environment before threads, load saved desktop proxy state, then apply an immutable launch route. First use follows inherited variables; explicit mode owns the standard variables and requires the backend proxy marker; corrupt or inaccessible saved state blocks all networking. Save validates fields and uses OS secret storage with no plaintext fallback, changes persistence only, and reports pending until a full quit/reopen. Loopback shell traffic always uses a no-proxy agent. Required-proxy url_fetch validates every hop without relaxing guards or permitting direct fallback. Redact known password forms across backend output chunks and diagnostics.

### Scope
Implement the item's complete desktop Rust/Console/Go url_fetch/docs scope and regression criteria. Do not change guard defaults, subprocess injection, remote Console/browser behaviour or add automatic restart. Keep existing first-use and non-marker url_fetch behaviour.

### Decisions
Use MISTER_MORPH_DESKTOP_PROXY_REQUIRED=1 for the backend marker. Put cohesive launch state, validation, persistence and secret-store abstraction in a desktop proxy module; expose only sanitized host DTOs. Use platform-supported credential-store crate and mock credential storage for deterministic tests. Reuse existing dialog/confirmation primitives and all locale catalogs. Fail closed for unexpected persisted data and unsafe required-proxy routes. Report environment/platform limitations truthfully instead of claiming native UI checks.

### Checking
Add fake HTTP/SOCKS and table-driven tests for routing, auth encoding, environment casing and bypass, blocked startup, persistence/secret failure, pending/save/clear, no-fallback, redaction across chunks, required-proxy guards/auth/redirects, and subprocess non-injection. Run configured Go formatting/vet/tests, cargo test, nsh check and the Console parallel test script; inspect cargo tree ureq features before/after. Inspect UI only if a supported native session exists, otherwise explicitly record not viewed. Real macOS/Windows/Linux desktop and real proxy checks must be listed individually as not checked when unavailable.

## factory · 2026-11-27 01:54

# FT191 coder report: desktop network proxy (HTTP and SOCKS5)

Branch `factory/FT191-desktop-network-proxy`, on `origin/master` = `098d31de` (no merge needed).

Commits:

- `c6e23dc0` feat(url_fetch): use the desktop's required proxy or refuse
- `1707f05c` feat(desktop): a network proxy setting (HTTP and SOCKS5) for the app's own requests

Nothing was pushed or fetched. `.github/workflows/`, `.factory/factory.toml`, `config.yaml` and `secrets/` are untouched. No config key was added, so `assets/config/config.example.yaml` is unchanged.

## What changed

### Desktop shell (`desktop/nsh`)

- `src/proxy.rs` (new): the setting, its validation, the settings file, the three launch states (System default, explicit, blocked), the two environments, pending detection, save, "switch to System default".
- `src/proxy_secret.rs` (new): the credential store behind a trait. The system store uses `keyring-core` with the macOS Keychain, Windows Credential Manager or Secret Service store; an in-memory store is used in tests.
- `src/redact.rs` (new): the filter for the proxy password, on whole lines with carry-over between reads.
- `src/main.rs`: the launch runs first in `main`, before `env_logger` and every thread: snapshot, load, set the process's variables once. `--check-update` in a blocked state prints the reason and exits with a failure, without a request. The backend is not started while blocked.
- `src/backend.rs`: every backend environment comes from the launch (`BackendConfig.env`); `None` refuses the start before a binary is looked for or downloaded. The health check uses a client without a proxy. Backend output goes through the line filter.
- `src/http.rs`: `agent` (proxy of the environment), `local_agent` (no proxy), `agent_for(url)` chosen by the target being loopback. All callers (`config.rs`, `files.rs`, `update.rs`, `backend.rs`) use it.
- `src/shell.rs`: the blocked view (Quit, Open Log, "Switch to System default and quit" with a warning and a confirmation), and the startup error view naming the running proxy and offering the same switch.
- `src/host.rs`: feature `networkProxy`, calls `morph.desktop.networkProxy.get` / `.set`.
- `src/desktop_log.rs`, `src/startup_error.rs`, `src/paths.rs`: filter on every log line, `proxy` in the diagnostics, `network-proxy.json`.
- `Cargo.toml` / `Cargo.lock`: ureq `socks-proxy`, the credential store crates.
- `README.md`: files, host contract, a "Network proxy" section with the boundaries.

### Console (`web/console-nsh`)

- `components/settings/NetworkProxySetting.tsx` (new): the row and the dialog.
- `lib/platform.ts`: `networkProxy()`, `saveNetworkProxy()`, `NetworkProxyError`.
- `pages/settings/sections/GeneralSection.tsx`: the row, only when `hasFeature("networkProxy")`.
- `lib/core/settings-search.js`, `pages/settings/SettingsPage.tsx`: Settings search finds the row only where it is shown.
- `lib/i18n/index.js`: 43 strings in each of `en`, `zh`, `ja`.
- `tests/network-proxy.test.tsx` (new), `tests/fixtures/integrations.tsx` (a `network-proxy` view).

### Go core

- `tools/builtin/url_fetch_required_proxy.go` (new) and a small hook in `url_fetch.go`. Nothing else in the core changed.
- Tests: `url_fetch_required_proxy_test.go`, `desktop_proxy_env_test.go`, `fakeproxy_test.go`, `internal/shellenv/desktop_proxy_env_test.go`.

### Docs (English)

- `desktop/nsh/README.md`, `docs/app.md` (the desktop guide), `docs/tools.md`, `docs/security.md`.

## Decisions

- **Marker**: `MISTER_MORPH_DESKTOP_PROXY_REQUIRED=1`, as the plan names it.
- **Host calls**: `morph.desktop.networkProxy.get` and `.set`. `set` answers `{ ok: false, error, fields | message }` instead of rejecting, because an nsh rejection carries only a string; `saveNetworkProxy` in `platform.ts` turns that into a thrown `NetworkProxyError` with per-field codes.
- **Where the row is**: the item names `SettingsAppPanel.tsx`, but General shows that panel in a web browser only (it is the "install as an app" card). The row is its own component, mounted in General's card next to Session, shown by the feature.
- **Clearing the password** is applied on Save (the dialog says so first), so Cancel discards it like every other edit.
- **Kept password must exist**: saving an explicit setting that keeps a stored password checks the store. If the entry is gone the save is refused on the password field, since the next start would otherwise be blocked.
- **Password with no user name**: refused on the password field, also when the user name is removed while a password is stored.
- **A user name with an empty password** is written as `user:@host`, so both Go and ureq send the user name.
- **Host**: saved lower-cased, IPv6 without brackets; a name ending in a numeric label is refused (it would be read as an address). Zone ids are refused.
- **Settings file**: unknown mode or type values are a parse failure (blocked); unknown extra keys are tolerated.
- **"Proxy variable inherited"** in System default means one of the six proxy names set to a non-empty value. The bypass list extended is `NO_PROXY` when set (even empty, as ureq reads it), else `no_proxy`.
- **Fail closed in `url_fetch`**: with the marker and no proxy for a non-loopback destination (for example the variables are missing), the request is refused. A custom non-HTTP transport is refused too.
- **Redaction** also covers Go's user-info and query encodings, lower-case hex, and URL-safe and unpadded Base64. A password of any length is redacted, so a very short one will mask unrelated text in the log.
- **Removing the stored password** is best effort: the file stops naming it first; a store that cannot be reached leaves an entry nothing reads, and that is logged.
- **Windows store crate** is used with its default features (the configuration its authors test).

## Cargo feature evidence (`cargo tree -e features -i ureq`, in `desktop/nsh`)

Full outputs: `ureq-features-before.txt` and `ureq-features-after.txt` beside this report.

- Before (`098d31de`): `default`, `gzip`, `platform-verifier`, `_ring`, `_rustls`, `rustls`, `rustls-no-provider`, `rustls-webpki-roots`, `_tls`. No `socks-proxy`: the suspicion is confirmed.
- After: the same plus `ureq feature "socks-proxy"`, requested by `mistermorph-desktop`. The tree still has one `ureq v3.5.1`, which `nsh-core` and `nsh-engine` use, so the feature holds for nsh's `fetch` and image loader too.
- Consequence, as the item expected: an inherited `socks5://` variable, ignored before, is now honored in System default (tested: used, or an error, never direct).

`Cargo.lock` gained `keyring-core`, `apple-native-keyring-store`, `windows-native-keyring-store`, `zbus-secret-service-keyring-store`, `secret-service`. Cargo also re-pointed several existing packages from `windows-sys` 0.52/0.59/0.60 to 0.61.2 when it resolved the new crates; that affects Windows builds only and was not built here.

## Test outcomes

All run with `TMPDIR` under the build's tmp folder and a throwaway `HOME` (with the `XDG_*` folders inside it).

| Command | Result |
| --- | --- |
| `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` | exit 0; 172 packages `ok`, 0 failed (run on the committed tree) |
| `cargo test --locked` in `desktop/nsh` | exit 0; 98 passed, 0 failed, 5 ignored (unit tests) and 1 passed (`tests/nsh_features.rs`). Base had 4 ignored; the fifth is the new read-only store probe |
| `cargo build --locked` in `desktop/nsh` | builds, 0 warnings |
| `nsh check` in `web/console-nsh` | exit 0, no findings |
| `web/console-nsh/scripts/test.sh` | exit 0; 174 files, 0 failed, 273 s. `tests/chat-topic-drag.test.tsx` failed beside the others and passed on the script's own rerun; it does not touch this change |
| `nsh test … tests/network-proxy.test.tsx` | 8 passed |

Regression matrix coverage:

- Rows 1–3, 5, 6, 18, 20–22, 24, 25 (core clients): `tools/builtin/desktop_proxy_env_test.go`, in a child process with the desktop's environment.
- Rows 4–6, 11–13, 19–23, 34 (desktop client and nsh-style agents): `desktop/nsh/src/proxy/tests.rs`, in a child process.
- Rows 7–9: `redact.rs` tests and `backend::tests::keeps_the_proxy_password_out_of_the_log`.
- Rows 10, 14–17, 36–44, 46: `proxy/tests.rs`.
- Rows 26–33: `url_fetch_required_proxy_test.go`.
- Rows 36–38, 46 and criteria 5–6 on the Console side: `tests/network-proxy.test.tsx`.
- Rows 47–48: `internal/shellenv/desktop_proxy_env_test.go`.

## Limitations and what was not checked

- **No native UI was viewed.** This machine has no display server for GPUI. The blocked view, the startup error view's new line and button, and the dialog in the real desktop window were not seen. The Console dialog was exercised headless with `nsh test` only; no screenshot was taken.
- **macOS: not built, not run.** No Rust target is installed. The Keychain store code (`cfg(target_os = "macos")`) was written from the crate's source and not compiled.
- **Windows: not built, not run.** The Credential Manager store code is not compiled; the case-insensitive handling of variable names (`is_name`) is untested; the `windows-sys` re-resolution in the lock is unbuilt.
- **Linux desktop: not run as an app.** The crate builds and its tests pass, but the packaged app was not started, so rows 19, 35 and 45 were not observed in a running app (the app logging in through a proxied environment, the Console WebSocket, the startup error view).
- **No real proxy and no real credentials** were used: fake HTTP and SOCKS5 proxies on loopback only.
- **Credential store on Linux**: one read-only probe against this machine's Secret Service answered (available, no entry); with no session bus it reports unavailable with an error that holds no secret. Nothing was written to the real store. Saving, reading and deleting a real entry was not exercised.
- **Launch-time store read and threads**: reading the password from the Secret Service happens before the process's variables are set, and its D-Bus client may leave a helper thread behind. Only an explicit setting with a stored password takes that path.
- **Rows 24, 34, 35 are narrower than written.** Row 24 is one generic streamed HTTP response through the HTTP proxy with Go's default client, not an LLM provider or an MCP SSE client. Row 34 uses agents built the way nsh builds its own, not the Console's real skill preview or image loader. Row 35 was not tested: nsh's WebSocket has no proxy code and connects to loopback only.
- **Rows 49 and 50** are documented, not tested: a coder session keeps its start environment; MCP stdio servers get the backend's environment (`internal/mcphost/host.go`).
- **Row 45** is covered by unit tests of the diagnostics and the state, not by a failing start in a window.
- **Remote images in chat Markdown**: not determined. Markdown renders through nsh's `TextView`; if it loads remote images it uses the same loader.
- **Backend log lines**: a search of the Go sources found no code that logs its environment or a proxy URL. Error texts from third-party libraries were not audited; the log filter is the second line of defense for those.
- **`socks5://` in System default** resolves names locally in the shell's client (ureq's behaviour for that scheme); only the explicit mode uses `socks5h://`.

## Installs not already pinned

- No tool was installed. New crates were downloaded into the shared cargo registry by `cargo fetch`: `keyring-core 1.1.0`, `apple-native-keyring-store 1.0.3`, `windows-native-keyring-store 1.1.0`, `zbus-secret-service-keyring-store 1.0.1`, `secret-service 5.2.0`, and the crates the lock now names for other platforms (they are pinned by `Cargo.lock`).

## Manager verification and process notes

Manager independently reran the configured gofmt/vet/go test gate on the committed tree: passed. The two commits contain only this item; no forbidden paths changed. Branch pushed at 1707f05c. No native UI was viewed. No macOS/Windows compile, packaged Linux app run, or real-proxy/credential write test was performed; review must inspect those limitations and the narrower matrix coverage above.

The coder also wrote build-memory notes outside its permitted worktree/TMPDIR and its harness wrote background-output files outside dir. This deviation is reported rather than hidden; no unrelated user files were removed. Newly observed top-level temporary paths were recorded in the run's outside list, not deleted. No user-level tool installs. Initial code push lacked credential HTTP path; retried with per-command credential.useHttpPath=true successfully.
