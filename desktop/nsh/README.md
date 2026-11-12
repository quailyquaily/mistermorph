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
[nsh 0.5.0](https://nsh.dev/docs/installation), Node (for `scripts/generate.mjs`) and Go.

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
| `<cache>/mistermorph/desktop/nsh-assets/<hash>/` | The console's fonts and icons, written once per build |
| `<cache>/mistermorph/desktop/updates/` | Update packages the check downloaded (`auto_update.enabled`) |

## The host contract

| Call | Desktop behaviour |
| --- | --- |
| `morph.boot` | `runtime: "desktop"`, `origin: http://127.0.0.1:<port>`, `basePath: "/"`, the last location, `kv.json`, the system's languages, the version, all eight features |
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

Closing the window quits (Linux, Windows) or hides the app (macOS), as before. Ctrl+Q / Cmd+Q
quits.

## Patches to nsh-platform-gpui

`vendor/nsh-platform-gpui` is nsh-platform-gpui 0.5.0 with the patches in `patches/` applied, wired
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
- `nsh-selection-copy.patch` (applied last): Ctrl+C (Cmd+C on macOS) and Ctrl+Insert copy
  the text selected in a selectable text or `selectable` view (the chat bubbles) while a text
  field keeps the keyboard focus. A press on page text does not take the focus from the field
  (the composer), and the field took the copy keys first, copying its own empty selection, so
  only the context menu's Copy worked. Now a field with nothing selected lets the copy keys go
  to the page's selection, and a mouse press that starts selecting page text collapses the
  focused field's selection to its caret, so one selection shows and the newest one is copied.
  The field keeps the focus, its caret and every other key.

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
