# Console mobile app: fix blank artifact previews

## factory · 2026-11-17 18:56

Owner request:
> 在手机 app 上 artifact 是是显示空白。需要修复。加到 factory new

Reported reproduction:
- In the Console conversation, generate a standalone Hello World HTML artifact, then open/view its artifact preview in the phone app (Android in this conversation's context).
- The user reports that the artifact is blank. The sample was `hello-world-20261117-185430.html` under `/var/cache/morph_nest`, with inline styling and an interactive greeting button.
- Root cause is not yet established. Inspect the current `web/console-nsh` artifact rendering and mobile host implementation; do not assume ChatView itself is a WebView or reuse the earlier unverified blob-download theory.

Scope and acceptance:
- Fix mobile artifact previews so a valid standalone HTML artifact displays its content instead of an empty area. Verify that inline styling and the sample greeting button work within the intended artifact security policy.
- Check artifact content loading, mobile preview routing/host integration, sizing, and relative resource resolution as appropriate to the diagnosed cause. Preserve existing authentication, path restrictions, and preview sandboxing; do not expose public artifact URLs or credentials.
- Show meaningful loading and failure states when content is unavailable or cannot be rendered, rather than silently leaving a blank preview.
- Preserve existing browser/desktop artifact previews. This is separate from FT143 attachment downloading; do not substitute a download action for a working preview.
- Add regression coverage for the diagnosed mobile rendering failure and relevant error handling. Run the required Console checks/tests. State explicitly whether the Hello World artifact was verified on an actual Android/mobile app, and document any remaining platform limitations.

Requested status: new. Investigation and implementation are pending.
