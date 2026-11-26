# MisterMorph Desktop (GPUI + nsh)

The desktop app as a Rust [GPUI](https://www.gpui.rs) shell that draws the nsh console in
`web/console-nsh` natively, without a WebView. It replaced the Wails app and keeps its behaviour
and files: it starts the bundled `morph` backend on a random loopback port, waits for it, and
stops it on quit.

| File | What |
| --- | --- |
| `build.rs` | Runs `node web/console-nsh/scripts/generate.mjs` and `nsh build --release`, embeds the bundle and its assets |
| `src/main.rs` | Start-up: config, `--check-update`, the desktop log, the backend, the window |
| `src/shell.rs` | The window: "Starting", the console (`AppView`), the startup error view; dialogs, window state |
| `src/host.rs` | The `morph.*` host contract of `web/console-nsh/lib/platform.ts` (the browser's is `host.js`) |
| `src/backend.rs` | Finding, downloading, starting, health-checking and stopping `morph console serve` |
| `src/update.rs` | The update check (`internal/updatecheck` in Rust) |
| `src/files.rs` | Picked files, uploads (multipart or raw, with progress; avatar re-encoding), saves |
| `src/config.rs`, `store.rs`, `window_state.rs`, `paths.rs`, `desktop_log.rs`, `notify.rs`, `startup_error.rs` | The small parts |

## Build

Needs Rust (the toolchain in `rust-toolchain.toml` is installed by rustup on first use),
[nsh 0.6.0](https://nsh.dev/docs/installation), Node (for `scripts/generate.mjs`) and Go.

On Ubuntu or Debian, GPUI also needs these development packages:

```bash
sudo apt-get install -y libfontconfig-dev libfreetype-dev libwayland-dev libx11-xcb-dev libxkbcommon-dev libxkbcommon-x11-dev libzstd-dev
```

and a Vulkan driver at run time (Mesa's `mesa-vulkan-drivers`, or the GPU vendor's).

Build the backend and the shell into one folder:

```bash
desktop/nsh/build.sh                    # -> bin/desktop-nsh/MrMorph and bin/desktop-nsh/morph
desktop/nsh/build.sh --debug            # unoptimized shell, faster to build
make -C desktop/nsh build               # the same through make; `make -C desktop/nsh run` starts it
```

`build.sh` builds the backend with `scripts/build-backend.sh --no-embed-frontend` (pure Go,
`CGO_ENABLED=0`, no web console inside: the shell draws the console itself) and the shell with
`cargo build --release`. The version shown in the app is `VERSION`, else `git describe`, else
`dev` (`MISTERMORPH_DESKTOP_VERSION` at compile time). `--pro` builds for the pro release
channel (`--features pro`, Go tag `pro`).

In a checkout where Go cannot read the VCS state (a linked worktree in a sandbox, say), run it
with `GOFLAGS=-buildvcs=false`.

`MISTERMORPH_DESKTOP_APP_DIR=<dir>` embeds a bundle `nsh build -o <dir> web/console-nsh` made
already, instead of building `web/console-nsh` (CI caching, or a tree that does not build).

Tests: `cargo test` (pure parts: config, saved values, window state, port reservation, backend
lookup, update check, uploads against a local server, image re-encoding). With a built backend,
`HOME=$(mktemp -d) MORPH_TEST_BACKEND=bin/desktop-nsh/morph cargo test -- --ignored` also starts,
stops and restarts a real one. `MORPH_NOTIFY_EXPECT=granted|unsupported cargo test -- --ignored
notify::tests::live` checks the session bus's notification service against what it should answer
(with `granted`, press the notification within a minute); run it under `dbus-run-session` for a
private bus.

## Run

```bash
bin/desktop-nsh/MrMorph                  # finds bin/desktop-nsh/morph next to itself
bin/desktop-nsh/MrMorph --config ~/x.yaml   # forwarded to `console serve`
bin/desktop-nsh/MrMorph --check-update      # prints the update check as JSON and exits
```

The backend is found as in the Wails app: `MISTERMORPH_DESKTOP_BACKEND_BIN`, `$APPDIR/usr/bin`
and `$APPDIR` (AppImage), next to the executable, `bin/` next to it, `./bin`, then `morph` on the
`PATH`; failing those it downloads the build channel's latest release into the cache
(`MISTERMORPH_DESKTOP_BACKEND_AUTO_DOWNLOAD=false` turns that off,
`MISTERMORPH_DESKTOP_BACKEND_VERSION` and `MISTERMORPH_DESKTOP_BACKEND_CACHE_DIR` as before).
It runs `morph console serve --console-listen 127.0.0.1:<port> --console-base-path / [--config …]`
and polls `/health` every 350 ms for up to 25 s. When that fails the window shows the startup
error view (Restart, Open Log, Copy Diagnostics, Quit). On Linux the backend gets `SIGTERM` if
the app dies without quitting (`PR_SET_PDEATHSIG`); on quit it gets `SIGINT`, then `SIGKILL`
after 4 s.

Files, as the Wails app kept them (`<config>` and `<cache>` are the OS's user config and cache
folders, `~/.config` and `~/.cache` on Linux):

| Path | What |
| --- | --- |
| `<cache>/mistermorph/desktop/logs/desktop.log` | The desktop log: the backend's output and the shell's events |
| `<config>/mistermorph/desktop/main-window.json` | Window size and position (the same file and format as the Wails app's) |
| `<config>/mistermorph/desktop/kv.json` | The console's saved values (`localStorage` in the browser) |
| `<config>/mistermorph/desktop/app-state.json` | The location the console was at, reopened on the next launch |
| `<config>/mistermorph/desktop/network-proxy.json` | The network proxy setting: mode, type, host, port, user name and whether a password is stored. The password itself is in the system's credential store, never in a file (see "Network proxy") |
| `<cache>/mistermorph/desktop/nsh-assets/<hash>/` | The console's fonts and icons, written once per build |
| `<cache>/mistermorph/desktop/updates/` | Update packages the check downloaded (`auto_update.enabled`) |

## The host contract

| Call | Desktop behaviour |
| --- | --- |
| `morph.boot` | `runtime: "desktop"`, `origin: http://127.0.0.1:<port>`, `basePath: "/"`, the last location, `kv.json`, the system's languages, the version, all ten features |
| `morph.kv.set` | `local` is written to `kv.json`; `session` lives as long as the process |
| `morph.history` | Remembers the location for the next launch (no back/forward: `morph.pop` is never sent) |
| `morph.title` | The window title |
| `morph.language` | Nothing (a window has no page language) |
| `morph.visibility` (event) | On window activation and visibility changes: `{ visible, focused }` |
| `morph.notify.state` / `request` | No desktop notification service asks an app permission, so both answer whether one is there. Linux: `"granted"` when a freedesktop notification service answers `GetServerInformation` on the session bus, `"unsupported"` when none does (the console then shows nothing and says so in Settings; the log notes the change once). macOS and Windows: `"granted"` (they tell an app nothing it could read: notifications the user turned off for the app are not seen) |
| `morph.notify.show`, `morph.notify.press` (event) | notify-rust, once per call (a failure rejects; nothing tries again). Pressing the notification (Linux: its default action, shown as "Open"; Windows: the toast's body) brings the window forward and sends `morph.notify.press`, which opens a task's topic. macOS reports no press |
| `morph.file.pick` / `release` | GPUI's open dialog (the desktop portal on Linux); `accept` filters the chosen files afterwards, since the dialog has no type filter. Images (up to 16 MB) get a `data:` preview of the picked bytes: nsh refuses `file://` images under `capabilities.network`, so only the chosen file is shown |
| `morph.file.upload` | Multipart (`field`, `fields`) or the raw file, chunked, with `morph.file.progress` events. With `image`, the picture is cropped, scaled (Lanczos3) and re-encoded first: **WebP is lossless** (the `image` crate has no lossy WebP encoder; `quality` applies to JPEG only) |
| `morph.file.save` | Fetches (`url` + `headers`) or decodes (`text`, `base64`) first, then GPUI's save dialog in the Downloads folder |
| `morph.desktop.pickDirectory` | GPUI's folder dialog (`title` and `current` are not passed: GPUI's dialog takes neither) |
| `morph.desktop.checkUpdate` | The Go check, ported; re-reads `auto_update` from the config every time; `channel` overrides it |
| `morph.desktop.restart` | Stops the backend, starts it again (new port), reloads the console |
| `morph.desktop.quit` / `openLog` / `ready` | Quit (stops the backend); the log in the system's viewer; logs `desktop_startup_frontend_ready` |
| `morph.desktop.networkProxy.get` | Feature `networkProxy`. `{ saved, running, pending, credentialStore }`: the saved setting without its password (`hasPassword` says one is stored), what the app runs with since it was opened (`mode`, and `type`, `host`, `port`, `username` for an explicit proxy), whether the two differ, and whether the system has a credential store |
| `morph.desktop.networkProxy.set` | `{ mode, type, host, port, username, password?, clearPassword? }`. Saves the setting and nothing else: no process starts or stops. Answers the new state with `ok: true`, or `ok: false` with `error` (`validation` with `fields` mapping a field to an error code, `credential_store` or `write` with a `message`); nothing is saved then. No answer holds a credential |

Closing the window quits (Linux, Windows) or hides the app (macOS), as before. Ctrl+Q / Cmd+Q
quits.

## Network proxy

Settings, General, "Network proxy" (`src/proxy.rs`). One setting owned by the shell, read once
at launch and turned into the standard proxy variables: one set for this process, one for the
backend it starts. A changed setting applies when the user quits and reopens the app; the app
never relaunches itself, and `morph.desktop.restart` starts the backend with the same launch
state again.

Two modes:

- **System default** (the default): the app follows the proxy variables it inherited. The
  backend gets the inherited environment exactly. The shell changes one thing for itself, and
  only when a proxy variable was inherited: its bypass list (`NO_PROXY` when set, else
  `no_proxy`) gains `localhost,127.0.0.1,::1,[::1]`.
- **Explicit proxy**: HTTP or SOCKS5, host, port, optional user name and password. The eight
  standard names (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY` and their lower-case
  forms) are taken over: inherited values are dropped, the six proxy names all carry the proxy
  URL, and the only bypass is loopback. The backend gets `http://` or `socks5://` (never
  `socks5h://`), `REQUEST_METHOD` removed, and the marker
  `MISTER_MORPH_DESKTOP_PROXY_REQUIRED=1`; the shell gets `socks5h://` for SOCKS5, so that its
  HTTP client resolves names at the proxy.

A saved explicit proxy that cannot be loaded (a file that cannot be read or parsed, a field that
fails validation, a stored password that is missing or cannot be read) **blocks the start**: no
backend, no update check, no download, no Console, no request. The window says why, by type,
host and port when they are known, and offers Quit, Open Log and "Switch to System default and
quit", which warns first and keeps the fields that can be read and the stored password.
`MrMorph --check-update` prints the same reason and fails. The startup error view offers the
same switch when the backend does not start under an explicit proxy.

What goes through an explicit proxy:

- The backend's HTTP, SSE and WebSocket requests: LLM providers, channels, `web_search`, MCP
  over HTTP, updates, skill installs, sign-ins, remote endpoints.
- The shell's update check and downloads, and the Console's own external requests (skill
  previews, remote images).

Blocked rather than proxied:

- `url_fetch` under the default guard settings, and whenever `allow_proxy` is false or
  `deny_private_ips` is true for a host name. See `docs/tools.md` and `docs/security.md`.

Not through the proxy, and not claimed:

- Commands the agent runs (bash, PowerShell) and the coder CLIs do not receive the proxy
  variables or the marker. Listing the names in `tools.bash.injected_env_vars`
  (`tools.powershell.injected_env_vars` on Windows) passes the app's values, password included;
  whether a program honors them is that program's matter. A coder session keeps the environment
  it started with.
- MCP stdio servers receive the variables; honoring them is theirs.
- Links open in the system browser, which uses the system's settings.
- The Console's WebSocket has no proxy support; in the desktop app it only connects to the
  app's own backend on loopback.
- Requests to `localhost`, `127.0.0.1` and `::1` never use a proxy. The shell's requests to its
  backend use a client without a proxy, chosen by the target and not by `NO_PROXY`.
- An HTTP proxy must allow `CONNECT` to the ports in use: the shell's client tunnels plain
  `http://` requests too.
- No PAC files, no reading of the OS proxy settings, no HTTPS-scheme proxies, SOCKS4, NTLM or
  Kerberos.

Secrets:

- The password is kept in the macOS Keychain, the Windows Credential Manager or the Secret
  Service on Linux (service `com.mistermorph.desktop`, account `network-proxy`). Without a
  credential store, saving a setting with a password fails; there is no plaintext fallback.
- While an explicit proxy with a password is running, the backend's environment contains the
  proxy URL with that password. Other processes of the same user can read it, and MCP stdio
  servers receive it.
- The shell names a proxy by type, host and port only. In explicit mode with a password it
  also filters the backend's output and the startup diagnostics on whole lines for the known
  forms of the password (as typed, percent-encoded, the `user:password@` part of a proxy URL,
  the Base64 of `user:password`). This is a second line of defense for those forms; it does not
  make arbitrary backend output safe.

ureq is built with its `socks-proxy` feature (`Cargo.toml`), which also holds for nsh's `fetch`
and image loader (the lock has one ureq): a `socks5://` proxy from the environment, ignored
before, is now used in System default too, or the request fails.

## Patches to nsh-platform-gpui

`vendor/nsh-platform-gpui` is nsh-platform-gpui 0.6.0 with the patches in `patches/` applied, wired
in through `[patch.crates-io]` in Cargo.toml. Drop the vendored copy once nsh or GPUI Fast ship
these. To rebuild it: copy the crate from the cargo registry to `crates/gpui/nsh-platform-gpui` in a
scratch git repo, `git apply` each patch in order, and copy the result back.

- `nsh-wayland-touchpad.patch`: GPUI's Wayland client multiplies touchpad scroll amounts by 3 and
  reports a finger lift as an empty move, so without it scrolling runs about three times too far
  and never glides. The patch divides the amount back and treats the empty move as the lift, so
  nsh's own momentum runs. It was found and tested by hand in the inua System Monitor spike; on
  X11 the divide has not been checked.
- `nsh-gpui-masks.patch`: GPUI has no alpha masks, so upstream ignores `maskImage` and the
  console's fade truncation and scroll-edge fades did not show on the desktop. The patch keeps the
  linear masks of the views being drawn and fades each glyph by the mask's alpha at its middle
  (fills, images and canvases are drawn as they are). (Its other half, repeating gradients drawn
  at the view's own size up to 4096 pixels a side, is in nsh 0.5.0 and was dropped from it.)
- `nsh-scroll-speed.patch`: real wheel and touchpad scrolls
  move twice the system's amount (`SCROLL_GAIN` in `src/events.rs`): a wheel notch scrolls 96
  points instead of 48, close to browsers on Windows, and a touchpad gesture and the glide after
  it go twice as far. The gain is applied once, where GPUI's deltas become nsh's; direction,
  empty moves (the Wayland finger lift), edges and momentum work as before. macOS keeps its
  own accelerated amounts. Ctrl + wheel keeps the system's amounts so pinch-zooming keeps its
  pace (and a Ctrl + wheel scroll with nothing to zoom moves at that pace too). The scrolls
  nsh's test agent sends (`src/agent.rs`) are not scaled.

`nsh-selection-copy.patch` (the copy keys copying a selected chat bubble's text while the composer
had the focus) was dropped with nsh 0.5.1, which solves it its own way: selecting page text with
the mouse (a drag, a double or triple click) takes the keyboard from the focused field, as in
browsers, so the copy keys reach the selection.

## Packaging

The app is two executables side by side, `MrMorph` and `morph`; there is no WebKitGTK. The
scripts in `packaging/` take both (`DESKTOP_BIN`, `BACKEND_BIN`, `VERSION`, `ARCH`) and are what
the release workflows run:

| Script | Makes |
| --- | --- |
| `package-darwin.sh` | `MrMorph.app` (bundle id `com.mistermorph`, which notifications are shown under), signed and notarized when the Apple settings are given, in a DMG; the updater tarball holds the `.app` |
| `package-linux-appimage.sh` | An AppImage (linuxdeploy bundles the shell's few libraries; the Vulkan loader and driver come from the host, which the shell opens at run time); the updater tarball holds the AppDir |
| `package-linux-deb.sh` | A `.deb` installing both into `/opt/mistermorph`, the icon theme and a desktop entry |

Linux runtime libraries: fontconfig, freetype, libxkbcommon(-x11), libwayland-client, libxcb,
libX11-xcb, zstd and a Vulkan loader and driver (`libvulkan1` plus `mesa-vulkan-drivers` or the
vendor's). The desktop entry is named after the window's app id, `com.mistermorph`, and says so
in `StartupWMClass`: Wayland compositors match the window to the entry, and its icon, by it. In
the AppImage the backend is found in `$APPDIR/usr/bin` and starts with the AppImage loader
variables removed.

Windows ships `MrMorph.exe` and `morph.exe` in a zip (`.github/workflows/windows-signing.yml`
signs them); `build.rs` embeds `packaging/icons/windows/appicon.ico` in `MrMorph.exe`.

The icons in `packaging/icons` and `packaging/appicon.png` are made by
`design/brand/generator/platforms.py`.

CI installs what the build needs (the GPUI packages on Linux, Node, nsh at the version the crates
pin, a Rust cache) with `.github/actions/setup-desktop-build`; bump its `nsh-version` together with
the `nsh-*` versions in `Cargo.toml`.

## macOS and Windows

The code is written for both (GPUI, notify-rust, `dirs` and the process handling are
cross-platform; Windows starts the backend with `CREATE_NO_WINDOW` and builds as a GUI-subsystem
executable in release) but was built and run only on Linux; the macOS and Windows builds come from CI
(`.github/workflows/build_app.yaml`). Not verified there:

- that it compiles and the window opens (Metal on macOS, DirectX on Windows);
- notifications: notify-rust shows them; Windows sends `morph.notify.press` for a press on the
  toast's body (`wait_for_response`, written from notify-rust's source but never run: toasts go
  out under PowerShell's app ID, and whether the press still arrives once the toast has gone to
  the Action Center is unknown); macOS sends none (waiting for it would send the notification
  twice on NSUserNotificationCenter), and "granted" is assumed on both;
- macOS: that the signed and notarized bundle from `packaging/package-darwin.sh` launches and
  shows notifications;
- Windows: a backend left running if the app is killed (no job object yet; Linux uses
  `PR_SET_PDEATHSIG`), and the icon `build.rs` embeds.
