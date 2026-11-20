---
branch: factory/FT170-login-view-endpoint-qr-redesign
round: 1
---
# Redesign the login view: password alignment and clearer endpoint setup with QR scanning

## factory · 2026-11-21 08:10
The owner requested: "The login page, the password entry, the mask button, is not aligned yet. And the login page, the entry to update endpoint is not so clear to understand, and there need a scan qr code button to fill the endpoint url easily. So please redesign the login view and fix issues. Add to new/"

### Requirements
- Redesign the login view for a clear, cohesive layout, prioritizing mobile while keeping desktop usable and consistent with the existing Console design.
- Fix alignment of the password field and its show/hide (mask) button. Keep the control vertically centered, with a comfortable touch target and no overlap with input text; toggling visibility must not shift the layout or lose the entered password.
- Make the currently selected server endpoint and the action to change it easy to find and understand. Use explicit labels and short explanatory text rather than an ambiguous icon-only entry. Keep manual URL entry available.
- Add a clearly labeled scan-QR-code button to endpoint setup. On supported devices, open a camera scanner, read an endpoint URL from a QR code, and fill the endpoint field for the user to review and save through the normal endpoint-update flow. Scanning alone must not automatically log in or send credentials to the scanned endpoint.
- Validate scanned input using the same endpoint URL rules as manual input. Explain invalid or unsupported QR contents without replacing the existing valid endpoint. Support cancel, permission denied, unavailable camera, unsupported browser, and retry without blocking manual entry. Stop camera access when the scanner closes or the view is left.
- Preserve existing authentication and endpoint persistence behavior. Provide accessible labels and keyboard operation, and prevent narrow-screen clipping or horizontal overflow.

### Acceptance checks
- Visually verify mobile and desktop login layouts, including password masked/unmasked, focus, validation errors, and long endpoint URLs.
- Verify the endpoint change action is understandable without guessing what an icon means; both manual entry and a valid QR scan can populate and save an endpoint.
- Add regression tests for password-control alignment/layout where practical, endpoint editing and validation, QR success/invalid content/cancellation/error handling, and camera cleanup. Record any camera/device checks that cannot be performed automatically.

## factory · plan · 2026-11-21 08:46

Behaviour
- Present a mobile-first login card with a stable password field and centered, accessible visibility control, plus a clearly labeled current server and change-server action wherever server changes are supported. Keep browser/desktop origin and existing auth behavior intact.
- Endpoint setup offers manual URL editing and an explicit Scan QR code action. Scanning requests camera access only on user action, shows cancellation/retry and useful unsupported/permission/no-camera errors, and fills a draft only after the existing parseServer validation. User must review and Save; scanning must never save, probe, authenticate, or transmit credentials by itself.
- Release tracks and pending scan work on close, cancellation, route departure and errors; ignore late results. Failed/invalid scans preserve existing draft and saved endpoint. Existing Save check and persistence/session invalidation remain unchanged.
Scope
- LoginPage, ServerDialog, focused password-control layout as necessary, a browser-host scanner contract plus platform wrapper, translations and focused tests. No changes to authentication protocol or backend endpoints, no deployment, no broad UI refactor.
Decisions
- Use browser camera + QR detector where supported via the existing host bridge (not DOM inside nsh); unsupported runtimes retain manual entry with explicit explanation. No unpinned decoder download or dependency unless demonstrably necessary. Respect actual pinned nsh version in repository (AGENTS says 0.6.0; config's 0.5.0 note is stale).
- Only URL QR payloads accepted using manual URL rules, no arbitrary JSON/commands. Keep desktop/web server-changing limitations rather than introducing a different persistence mechanism.
Checking
- Tests for toggling preservation and control layout, manual editing/validation/save, scan success without Save/login calls, invalid data, cancel/retry/errors, track cleanup and late camera resolution.
- Run nsh check, Console scripts/test.sh, required gofmt/vet/go test gate. Use throwaway HOME and all temp data beneath TMPDIR. Attempt mobile/desktop visual checks if supported; explicitly report anything unverified, especially real camera/device behavior.

## factory · 2026-11-21 08:46

Built at 83ce7dd1 (start point 460810dd). Login now has a labeled server row, explicit change-server action on mobile, and a stable inset password visibility control. Server setup provides QR scanning with manual entry, validation, draft-only scan results, retry/cancel/error states, and camera cleanup including late events and backgrounding. Existing save and authentication behavior is preserved.

Decisions: the scanner uses an inline nsh WebView page rather than the planned host.js contract, because server changing is mobile-only. Uses getUserMedia and BarcodeDetector; unsupported platforms retain manual entry. QR content also rejects whitespace, embedded credentials and non-http scheme payloads. Added mobile webview camera capability, iOS usage text and Android manifest camera permission/optional hardware. Added a TextField layout callback for regression measurements. No backend or authentication protocol changes.

Tests: manager independently reran the required gofmt + go vet ./... + go test ./... gate successfully. Coder reports nsh 0.6.0 check passed; required Console scripts/test.sh passed (155 files, zero final failures; one unrelated dialog-sheet test passed its solo retry); scanner-page Node tests and Android manifest tests passed. Regression tests cover password layout/preservation, endpoint editing, scan success without saving or authentication, invalid content, cancel/error/retry, cleanup and late results.

Visual checks: coder used existing Chrome with nsh 0.5.1 web runtime at 320, 390 and 1280 widths for masked/shown/focused/error password states and long endpoint URLs, with no horizontal overflow. Scanner unsupported/denied bridge paths checked in browser.

Not checked: actual camera/permission prompts and real QR codes on devices; Android BarcodeDetector availability and APK build; iOS device behavior (WKWebView lacks BarcodeDetector, expected unsupported); live camera preview appearance; nsh 0.6 web-runtime rendering; dark mode and rendered zh/ja layout. Owner/reviewer should check real Android QR success and camera cleanup, and assess the iOS unsupported limitation.

Installs: none (existing Chrome, playwright-core and runtime reused; no dependency manifest or lockfile changes). Branch pushed; not merged or shipped. Initial branch credential-helper request needed a command-scoped credential.useHttpPath=true retry, which succeeded.
