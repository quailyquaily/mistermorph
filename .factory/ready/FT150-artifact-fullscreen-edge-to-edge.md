---
branch: factory/FT150-artifact-fullscreen-edge-to-edge
round: 1
---
# Remove outer spacing from fullscreen artifact previews

## factory · 2026-11-18 18:13
Owner requests a UI fix: fullscreen artifacts should not have margins around the WebView/preview. The spacing may come from the surrounding dialog's padding; inspect the actual source rather than assuming it belongs to the WebView.

Requirements:
- In fullscreen mode, make the artifact WebView/preview fill the available content area edge to edge, removing unintended outer margins, padding, or gaps introduced by the preview container or dialog.
- Do not strip spacing authored inside the artifact itself, and preserve the normal non-fullscreen preview layout.
- Keep fullscreen close/exit controls visible and usable; avoid clipping, unwanted outer scrolling, and regressions on desktop or mobile, including necessary safe-area handling.
- Verify entering and exiting fullscreen, viewport resizing, and desktop/mobile layouts; add focused regression coverage for the fullscreen container sizing and spacing.

## factory · plan · 2026-11-18 18:28
Behaviour: Preserve the inline bordered 384pt preview. In fullscreen, fill the dialog content below its existing title/exit bar without outer body padding. Preserve safe areas, artifact-authored spacing, loading/error states, and ticket state when returning inline. Follow available dimensions on resize.
Scope: Inspect the actual shared Modal body and ArtifactPreviewCard; use a narrow opt-in for flush content rather than changing normal dialogs or artifact documents. No ticket API changes.
Decisions: Edge-to-edge means the content slot inside the existing panel, not hiding close controls, removing safe areas, or changing the panel's established desktop margins and height cap. Prefer measured layout regression tests.
Checking: Exact frame bounds on desktop/mobile including insets, resize and back, enter/exit, inline geometry, and failed-page re-entry. Run nsh check, the required parallel Console scripts/test.sh, and root gofmt/vet/tests. Inspect UI if available and record runtime/device limitations.

## factory · 2026-11-18 18:28
Built commit 192e3ef7 on factory/FT150-artifact-fullscreen-edge-to-edge. The unintended 16pt gap came from Modal's non-scrolling p-4 body. Added opt-in flush body styling and enabled it only for fullscreen artifact previews, rendering the frame directly in the body. Existing title/close controls, panel borders, desktop margins/height cap, safe areas, inline layout and artifact spacing remain unchanged.
Tests: nsh check passed. Console scripts/test.sh passed all 136 files; chat-attachments passed its automatic isolated rerun after an intermittent parallel failure. Root required gofmt check, go vet ./..., and go test ./... passed in the coder run and again in manager verification. Exact geometry regressions cover phone, inset phone, desktop, resize/back, exit restoring inline geometry, and failed-page re-entry; all three new cases fail without flush.
UI verification: Coder inspected real Chrome at desktop, resized desktop, and mobile dimensions with/without simulated safe areas, including artifact-authored 24px margin and visible close controls. Caveat: Chrome used the already-installed nsh 0.5.1 web runtime because the 0.6.0 web runtime was unavailable; exact shipping runtime, physical Android/iOS devices and desktop native app were not inspected. Headless tests used nsh 0.6.0.
Installs: none beyond pinned dependency restoration; no manifests/lockfiles or config keys changed. No forbidden paths changed. Moved new/ → review/, round 1. Initial push credential-helper path error was resolved on the single retry with command-local credential.useHttpPath=true; no user settings changed.

## factory · review · 2026-11-18 18:54
head: 192e3ef7a021bd5cf4babec32f2cde1ff9baa988
verdict: pass
Reviewed origin/master...HEAD with Claude Code against the request and plan; all four changed files inspected. No findings. Merge with current origin/master is clean. Manager confirmed the reviewed head and clean worktree; no review commits or source edits.
Validation: required root gofmt check, go vet ./..., and go test ./... passed (163 packages ok). nsh 0.6.0 check passed. Console scripts/test.sh passed all 136 files in 352s; six parallel failures passed the runner's isolated retries. The artifact-preview tests passed; restoring the old padding in a scratch copy makes all three new geometry cases fail. Desktop/mobile frame bounds, safe-area insets, resize/back, exit to inline layout, and failed-page re-entry are covered.
Installs: none; no downloads, manifest changes, or lockfile changes.
Residual risks: this review did not inspect a real browser, desktop native app, or physical Android/iOS devices. Native WebView bottom-corner clipping, artifact scrolling, and keyboard interaction were not tested. The build's browser inspection used the older 0.5.1 web runtime, not shipping 0.6.0. Owner should check these native/runtime behaviors before shipping if relevant. Existing factory settings mention nsh 0.5.0 while AGENTS.md pins 0.6.0; review used the repository pin.
Moved review/ → ready/.
