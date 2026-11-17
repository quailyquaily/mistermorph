---
branch: factory/FT146-console-shell-server-version
round: 1
---
# Console: distinguish Shell Version and Server Version across platforms

## factory · 2026-11-17 19:16

Owner request:
> How about show the Shell Version and the Server Version? So we can apply this to all platform, right?
> Add to factory new/

Context:
- Investigation reported that Android Settings uses an empty shell version and falls back to the connected server version, which can misrepresent the installed app and its update status. Treat the reported code locations as investigation leads, not a substitute for checking the current implementation.
- Use consistent terminology across supported Android, iOS, desktop, and browser Console environments.

Scope and acceptance:
- Show separate **Shell Version** and **Server Version** fields in Settings, with appropriate localization. Shell Version means the installed native app/wrapper version; Server Version means the version reported by the currently connected Console server.
- Supply actual shell build metadata through the host interface on supported native platforms. Do not substitute the server version when shell metadata is missing; show Unknown instead. In a regular browser, omit Shell Version or show Not applicable.
- Keep server and shell version sources separate, including reconnecting to a different server. A missing or failed server version lookup must not be represented as a known shell version.
- Separate update checks and their displayed results by target: shell checks use installed shell metadata and platform-appropriate releases/update mechanisms, while server checks use server metadata. Do not report the shell as up to date based on the server version. If shell update checking is unavailable, say so explicitly rather than using the server check as a fallback.
- Preserve existing platform behavior unrelated to version reporting; do not invent unsupported native integrations. Document any unsupported platform metadata/update mechanism.
- Add regression coverage for differing shell/server versions, missing shell metadata, browser behavior, unavailable server metadata, and update-target selection. Run required Console checks/tests and state which native platforms were actually verified.

Requested status: new. Implementation is pending.

## factory · plan · 2026-11-17 21:11

Behaviour: independently show installed native Shell Version and connected Server Version; missing native metadata is Unknown, browsers omit shell, and failed/reconnected server lookups clear stale server results. Each update action and result belongs to its target, never borrowing the other version.

Scope: Settings UI and localized search/labels, host metadata contract and Android native metadata, update-target helpers, regression tests, English documentation. Preserve existing desktop integration and unrelated native behaviour.

Decisions: keep desktopVersion compatibility; Android reads installed APK package metadata through morph.shell.info. Unsupported iOS metadata is Unknown and shell checking explicitly unavailable. Browser retains device downloads; native server checks do not offer a device installer.

Checking: differing/missing versions, browser behaviour, unavailable server and reconnects, update targeting; run required Go gate, nsh check, parallel Console test script and Android JVM tests. Native device checks and visual inspection are not available.

## factory · 2026-11-17 21:11

Built and pushed 4d02050b (round 1): separate shell/server rows, checks and release results; Android installed-version host call; English, Chinese and Japanese strings; helper/UI/JVM regression coverage and platform support documentation.

Tests: manager independently passed `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` and `nsh check`. Coder's required Console script completed: 133 files, 0 failed, 246 seconds. Coder reports Android JVM tests: 15 passed plus ShellInfoTest: ok. Manager's Android JVM rerun could not start because javac was not on its PATH; this does not negate the coder's recorded pass.

Installs: none reported; no dependency manifest changes.

Not checked: no real Android device/emulator, iOS build or running desktop app, and no live browser visual inspection. Android sources compiled and a diagnostic APK was built using an existing older 0.4 runtime, but that mismatched-runtime APK is not runnable and was deleted; a supported 0.5.1 Android runtime build still needs verification. Desktop Rust unchanged and not rebuilt. Review should inspect the native metadata path and separate update-target behaviour.

Moved new/ → review/.
