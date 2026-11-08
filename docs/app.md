# Desktop App

Mister Morph includes a desktop App that runs the Console backend and draws the Console natively.

## User Quick Start

Download a release asset from the [release list](https://mistermorph.com/releases/) (GitHub Releases keeps the latest 10):

- macOS `arm64`: `MrMorph-darwin-arm64.dmg`
- Linux `amd64`: `MrMorph-linux-amd64.AppImage` or `MrMorph-linux-amd64.deb`
- Windows `amd64`: `MrMorph-windows-amd64.zip`

Then:

1. open the App
2. finish setup
3. use the local Console

You do not need to run `morph console serve`.

## Current Shape

The desktop code lives in `desktop/nsh`: a Rust [GPUI](https://www.gpui.rs) shell that draws the
nsh Console (`web/console-nsh`) natively, without a WebView.

- the shell owns the native window and runs the Console's TSX app with nsh
- a child process runs the bundled backend with `console serve`
- the Console talks to that child process over HTTP on the loopback interface

The shell handles the window, the backend's lifecycle and restart, and the Console's host
functions (files, notifications, update checks). `desktop/nsh/README.md` has the details.

## Architecture

```text
+--------------------------------------------------------------+
| Desktop App Process (MrMorph, GPUI)                          |
|                                                              |
|  +----------------------+        +------------------------+  |
|  | Console (nsh, TSX)   | -----> | Backend manager        |  |
|  | drawn by GPUI        |  HTTP  | start/stop/health      |  |
|  +----------------------+        +------------------------+  |
|             |                              |                 |
|             | morph.* host calls           |                 |
|             v                              |                 |
|  +----------------------+                  |                 |
|  | Host (files, notify, |                  |                 |
|  | update, restart)     |                  |                 |
|  +----------------------+                  |                 |
+--------------------------------------------|-----------------+
                                             |
                                             | spawn
                                             v
                         +---------------------------------------+
                         | Child: bundled backend `console serve` |
                         | listen: 127.0.0.1:<random>            |
                         | base path: /                          |
                         +---------------------------------------+
```

## Startup and Restart

Startup sequence:

```text
desktop main
  -> resolve backend binary path
  -> reserve random loopback port
  -> spawn child: bundled backend console serve
  -> poll GET /health until ready (every 350 ms, up to 25 s)
  -> show the Console, or the startup error view if the backend did not start
```

First run:

```text
incomplete config
  -> console backend starts without login (no password set)
  -> Console routes to /setup
  -> user saves agent settings + identity/soul
  -> Console asks the shell to restart the backend
```

A restart stops the backend, starts it again on a new port and reloads the Console. The
startup error view offers Restart, Open Log, Copy Diagnostics and Quit.

## Paths and Configuration

- The shell embeds the Console it draws; the bundled backend serves only the API.
- `--config <path>` passed to the desktop App is forwarded to the child `console serve` process.
- `--check-update` checks the desktop release manifest and prints JSON, then exits.

Enable update checks in config:

```yaml
auto_update:
  enabled: true
  # Optional: community or pro. Defaults to the channel this build came from.
  channel: community
```

With this enabled, desktop startup checks the latest update manifest of the release channel, `https://downloads.mistermorph.com/<channel>/latest/update.json`, and downloads a verified update package into the user cache. `--check-update` also uses this setting to decide whether to download. It does not replace the running app yet: applying the update still needs a platform-specific install/relaunch step.

## Local Build and Run

The build needs Rust (rustup installs the toolchain in `desktop/nsh/rust-toolchain.toml`),
[nsh 0.4.0](https://nsh.dev/docs/installation), Node and Go. On Ubuntu or Debian, GPUI also
needs these development packages, and a Vulkan driver at run time:

```bash
sudo apt-get install -y libfontconfig-dev libfreetype-dev libwayland-dev libx11-xcb-dev libxkbcommon-dev libxkbcommon-x11-dev libzstd-dev
```

Build the app and its backend into `./bin`:

```bash
./scripts/build-desktop.sh --release   # ./bin/MrMorph and ./bin/morph (nsh Console embedded)
./bin/MrMorph
```

Without `--release` the shell is a debug build. `desktop/nsh/build.sh` builds both into
`bin/desktop-nsh/` with a backend that embeds no Console; `make -C desktop/nsh run` builds and
starts it.

## Release Packaging

Tagged releases currently publish:

- macOS `arm64`: `MrMorph-darwin-arm64.dmg`
- Linux `amd64`: `MrMorph-linux-amd64.AppImage`, `MrMorph-linux-amd64.deb`, and `MrMorph-linux-amd64.tar.gz`
- Windows `amd64`: `MrMorph-windows-amd64.zip`

The package includes a sibling `morph` backend binary, so `MrMorph` can start `console serve` locally without a first-run download.

The Linux deb package installs the app under `/opt/mistermorph`, adds the desktop entry under `/usr/share/applications`, and installs the app icon into the hicolor icon theme and `/usr/share/pixmaps`.

That backend is built with `CGO_ENABLED=0` on purpose. Keep it that way unless you have a packaging plan to change it.

The packaging scripts are in `desktop/nsh/packaging/` (DMG, AppImage, deb). CI installs the
desktop build's tools through `.github/actions/setup-desktop-build` (the nsh release the shell's
crates pin, v0.4.0); `build_app.yaml` builds and packages the app for Linux, macOS and Windows
when run by hand (Actions, "Build Desktop App") or for a pushed tag that is not a release tag.

The macOS tag release job requires Apple signing secrets in GitHub Actions. It imports the Developer ID Application certificate into a temporary keychain, signs the app bundle, signs the DMG, submits the DMG through `notarytool`, staples the ticket to the DMG and app bundle, then uploads the release assets.

## Android App

The console also builds as an Android app (`web/console-nsh/scripts/build-android.sh`). It is a client
only: on first launch it asks for the address of a running `morph console serve` (for example
`192.168.1.5:9080` on the local network, or an `https://` address), checks that a console answers there,
and logs in as the web console does. Plain `http://` addresses work; the console shows its usual
warning about them.

```bash
web/console-nsh/scripts/build-android.sh                          # web/console-nsh/dist-android/MrMorph.apk, debug key
web/console-nsh/scripts/build-android.sh --abi x86_64 --run       # for an emulator: install and start it
NSH_KEYSTORE_PASSWORD=… web/console-nsh/scripts/build-android.sh --keystore release.keystore --key-alias morph
```

It needs nsh 0.4.0, Node and the Android SDK (`ANDROID_HOME`, with `platforms;android-35` and build
tools); no NDK and no Gradle. Tagged releases publish `MrMorph-android.apk` when the repository has the
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` secrets: Android only
updates an app signed with the same key, so releases are never signed with a runner's debug key.

Not available in the Android app yet: attaching files other than images, system notifications,
changing avatars and saving files (log exports, downloads).

## Known Gaps

- Local macOS test packages can still use ad hoc signing; those builds may require testers to manually bypass Gatekeeper on first launch.
- Windows ships as a zip bundle, not an installer.
- The shell has been run only on Linux so far; the macOS and Windows builds are new (see
  `desktop/nsh/README.md` for what is not verified there).
- The shell still reuses the CLI backend through child-process orchestration rather than an in-process console module.
