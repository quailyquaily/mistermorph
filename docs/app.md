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

Without `--config` the config is in agent.db, and the shell reads `auto_update` from the backend once it runs. When the Console has a password, the shell reads it with the Console's login, so a desktop that is not logged in yet checks for updates after the login.

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

Android's Back (the back button, or the swipe in from the screen's edge with gesture navigation) closes
an open dialog or menu, then does what the screen's own back arrow does (an open topic back to the topic
list, a settings section back to the sections, the skill store back to Skills, Logs back to Settings),
also when the app opened on that screen. A screen without a back arrow (Topics, Contacts, TODO and the
other pages of the bottom navigation) takes no Back, whatever pages were opened before it: there Back
leaves the app. The app keeps its pages clear of the status bar and the
navigation bar in portrait and landscape.

Voice input works as in the web console: the composer's mic shows while the agent's
`llm.routes.transcription` route is ready (`GET /voice/transcribe`). The app records with Android's
microphone (AAC in an `.m4a` file in its cache), sends the recording to the agent's
`/voice/transcribe` when the mic is pressed again, and adds the text to the draft, which is never sent
by itself. The first recording asks for the microphone; after a refusal the next tap asks again, and
once Android stops asking (refused twice, or "Don't ask again") the app explains how to allow it in
Settings. Leaving the app, or switching to another topic or agent, ends the recording or its
transcription and deletes the file; recordings are also deleted once sent or discarded. nsh records
no audio itself, so this comes from the app's own Java (`web/console-nsh/android/src`), which the
build compiles into the APK.

```bash
web/console-nsh/scripts/build-android.sh                          # web/console-nsh/dist-android/MrMorph.apk, debug key
web/console-nsh/scripts/build-android.sh --abi x86_64 --run       # for an emulator: install and start it
NSH_KEYSTORE_PASSWORD=… web/console-nsh/scripts/build-android.sh --keystore release.keystore --key-alias morph
```

It needs nsh 0.6.0 (`nsh` on `PATH`; the build adds its Android runtime component when missing and
fetches that release's `nsh.aar`), Node, a JDK (`javac`; `JAVA_HOME` is honoured) and the Android
SDK (`ANDROID_HOME`, with `platforms;android-35` and build tools); no NDK and no Gradle. The native
part's tests run on the JDK alone: `web/console-nsh/scripts/android-host.sh test`. Tagged releases publish `MrMorph-android.apk` when the repository has the
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD` and `ANDROID_KEY_ALIAS` secrets: Android only
updates an app signed with the same key, so releases are never signed with a runner's debug key.

Wide tables and code blocks in replies scroll sideways inside the chat, and the Jobs graph scrolls
both ways when it is larger than the screen. nsh 0.6.0's Android scroll view cancelled such a drag
in the scroll view around it, so the build replaces it with a patched copy from the app's own Java;
it builds only with nsh 0.6.0. See [the feature notes](feat/feat_20261125_android_nested_scroll.md)
for the cause, the fix and what still needs a check on a device.

Task notifications work as in the web console, with the same option: Settings → System → Topic task
notifications. When a task in one of the person's topics finishes or fails while the app is not in the
foreground, the app shows a notification with the topic's name and whether the task finished or
failed, nothing of its text; TODO items' runs never notify. Pressing it opens the topic, or the chat
when the topic is gone. The app asks for Android's notification permission only from that row's
button (Android 13 and newer ask; older versions allow notifications unless they were turned off in
the system settings). See [the feature notes](feat/feat_20261110_android_task_notifications.md) for how
it works and its limits.

Saving files works with Android's own picker: a file the agent sent (its download icon button),
a workspace or artifact download, or a log export asks where to save it in the system's "save to"
screen (the Storage Access Framework, so the app holds no storage permission), offering the file's
own name. The app then downloads the file from the console server with the session and writes it
there; the button stays busy until every byte is written and shows a check once it is. Backing out
of the picker saves nothing and says nothing; a failed download or write says why, deletes the
document it had started, and the button tries again. Only the console server's own addresses get
the session, and the download follows no redirects. nsh has no save dialog on Android, so this also
comes from the app's own Java; an APK built without it, or a device without a document picker, says
that saving is not available. Other phones (iOS) have no saving yet.

Keyboard shortcuts are on in the Android app only while a hardware keyboard is connected: the native
part reports it (`morph.keyboard.state`, `morph.keyboard.changed`) from Android's input devices, and
an APK without the native part, or a state Android cannot tell, leaves them off. See
[Keyboard shortcuts](console/keyboard-shortcuts.md#where-shortcuts-are-on).

Not available in the Android app yet: attaching files other than images, other system notifications
(TODO items' opt-in notifications) and changing avatars.

## Shell and Server Versions

Settings → System → Updates shows two versions in one list, each from its own source and with its
own update check. Neither ever stands in for the other: a version that cannot be read is shown as
Unknown. Each row names its component, the installed version and, after a check, what is available.

One **Check for updates** button runs every check there is, side by side. Each ends for itself: a
failed check says so in its own row and leaves the other's answer. The card offers no release
channel to pick: its checks read the Community release (`channel=community`), whatever channel the
server's settings hold, and save nothing. The release notes of what the checks found are one list
below both rows; components that found the same release with the same notes share one entry, named
for both. A download stays its component's own, under that component's row, and is only ever opened
by pressing it: checking installs and restarts nothing.

- **Shell version**: the installed app the Console runs in (its shell), as that app was built. The
  host reports it in its boot data (`lib/platform.ts` `shellInfo()`): the desktop app as
  `desktopVersion` (`MISTERMORPH_DESKTOP_VERSION` at build time, `dev` otherwise), the Android app
  through its native part (`morph.shell.info`: Android's version name and version code of the
  installed package, which `build-android.sh` sets from `VERSION`). A browser has no shell, so the
  row is not shown there.
- **Server version**: the console server the Console is connected to, from that server's
  `GET /settings/auto-update` (`current_version`). Each load starts over, so connecting to another
  server never shows the previous server's version or check result; a failed lookup is Unknown.

The checks follow the same split:

| Where | Shell check | Server check |
| --- | --- | --- |
| Desktop app | The desktop app's own check (`morph.desktop.checkUpdate`, its version against the release manifest) and the file for this machine | The server's check (`POST /settings/auto-update/check`), no download for this device |
| Android app | The release's Android app (`POST /settings/auto-update/check?download_os=android`, which reads the release feed) compared with the installed version; the APK download | The server's check, no download for this device |
| iOS app | Not available: no iOS app is published and nsh has no store lookup; the version is Unknown unless a host answers `morph.shell.info` | The server's check, no download for this device |
| Browser | None (no shell) | The server's check with the download for this device (`download_os`, `download_arch`) |

When the shell's version is unknown (an Android build without the native part, an iOS build), the
row says its updates cannot be checked rather than borrowing the server's result; a desktop host
without the `checkUpdate` feature says checking is unavailable. The Android app is updated by
installing the newer APK by hand; nothing installs it in the background.

## Known Gaps

- Local macOS test packages can still use ad hoc signing; those builds may require testers to manually bypass Gatekeeper on first launch.
- Windows ships as a zip bundle, not an installer.
- The shell has been run only on Linux so far; the macOS and Windows builds are new (see
  `desktop/nsh/README.md` for what is not verified there).
- The shell still reuses the CLI backend through child-process orchestration rather than an in-process console module.
