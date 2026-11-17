---
branch: factory/FT144-console-mobile-artifact-blank-preview
round: 1
---
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

## factory · plan · 2026-11-17 20:14

Behaviour: Trace mobile artifact ticket creation through URL resolution, native WebView mounting and loading. Valid standalone HTML must display styled content and interactive JavaScript within the existing sandbox; keep relative resources working. First opening shows loading; ticket, navigation and rendering errors show a meaningful failure instead of blank space. Collapsed and fullscreen previews must retain working sizing and lifecycle.
Scope: Fix the diagnosed defect in Console artifact rendering/mobile host integration, plus focused regression coverage and English limitation notes. Preserve desktop/browser behavior, ticket authentication, path restrictions and sandboxing. No download replacement, public artifact URLs or unrelated refactors.
Decisions: Investigate the native nsh Android integration rather than assume the entire chat is a WebView. Prefer a narrow application-level supported WebView fix; if host support is missing, implement the smallest feasible safe host integration. Choose defaults without asking. Do not claim actual-device validation without a device.
Checking: Add regression tests demonstrating diagnosed mobile defect and loading/error handling, preserving existing preview security and relative URL behavior. Run required Console nsh check and scripts/test.sh, and repository gofmt/vet/go test gate. Explicitly report actual Android/device availability, visual verification and remaining platform limitations.

## factory · 2026-11-17 20:14

Built commit: c15bf085 (fix(console): show artifact previews instead of a blank frame).

Diagnosis: the preview-ticket server returns a root-relative entry_url. The card passed it directly to nsh WebView; nsh 0.5.1 capability checks reject a URL with no host (ERR_ACCESS_DENIED). Existing tests supplied an absolute URL and missed the defect; the card also ignored WebView onError.

Implemented absolute console-origin URL resolution for artifact WebView/Image, explicit loading and failure states, retry, inline/fullscreen lifecycle handling, translated strings and regression coverage. Preserved authentication, ticket renewal, path restrictions and existing preview sandbox; downloads remain separate.

Checks: manager independently reran the required gofmt/vet/go test gate; all passed. Coder ran nsh check (0.5.1) and required scripts/test.sh: 133 files, 0 failed. Nine focused artifact tests cover the diagnosed path rejection, loading/errors/retry, unsupported WebViews and sizing. Negative-control tests fail when the URL fix is removed.

Visual verification: coder verified equivalent styled Hello World HTML with working greeting button against the real Go server in Chrome phone/desktop layouts; relative CSS/JS/image resources, fullscreen, retry, opaque sandbox origin and folder path restriction checked. Actual Android app/device/emulator NOT verified (no adb, emulator or KVM); native desktop app NOT verified. Headless loading/error events are simulated except actual capability rejection. Browser iframe HTTP 401/404 responses still display the server error page because iframe does not report HTTP status.

Installs: none; no manifest/dependency changes. Repository pins nsh 0.5.1, used despite stale board rule naming 0.5.0. Coder reported an accidental scratch directory outside the run directory, immediately relocated into run temporary storage. Initial branch push lacked credential request repository path; one retry with per-command credential.useHttpPath=true succeeded. No base/tag push or deployment.

Moved new/ → review/. Owner should check the actual Android app preview, greeting button and fullscreen behavior.
