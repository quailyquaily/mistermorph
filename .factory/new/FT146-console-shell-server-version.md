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
