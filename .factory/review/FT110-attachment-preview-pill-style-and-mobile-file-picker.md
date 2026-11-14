---
branch: factory/FT110-attachment-preview-pill-style-and-mobile-file-picker
round: 2
---
# Attachment previews, rounded file pills, and mobile file picking

## factory · 2026-11-14 06:44
Owner request from Console:

> Select a file in composer, the file pill can't be previewed even if it's just a picture. After sending, it can be previewed in the bubble.
> And the pill needs more border radius, just like the single line composer.
> When the pill is in the bubble, remove the file type at its right, because the file extension already tells us.
> And the Upload files should support to pick files instead of photos on the phone. You can implement those telegram-like attachment pick views as the screenshot shows.
> Add to new/

### Required behavior
- Before sending, clicking/tapping a selected image attachment in the composer opens a preview, consistent with the preview available after sending. Keep attachment removal independently usable; previewing must not submit the message or discard the draft.
- Give file pills a larger border radius, visually matching the single-line composer's rounded shape. Preserve rounded corners in both draft and sent states, including narrow screens; do not regress FT107.
- In sent message bubbles, remove the redundant file-type label at the pill's right. Keep the filename and its extension, and retain useful actions/metadata unrelated to that redundant label.
- On phones, Upload files must allow choosing arbitrary supported files from the system file/document picker, not only choosing photos. Provide clear Gallery and File choices using the attached Telegram screenshots as the visual/interaction reference. Gallery opens photo selection; File opens the system file/document picker. Do not pretend a web app can enumerate private storage or Telegram's app directory: use platform-supported pickers and sensible browser fallbacks.
- Preserve existing upload limits, validation, multiple-attachment behavior, sent-image previews, and desktop file selection.

### Reference screenshots
- [Telegram Gallery attachment view](../references/FT110/telegram-gallery-picker.jpg)
- [Telegram File attachment view](../references/FT110/telegram-file-picker.jpg)

Use the Gallery/File separation and rounded attachment-sheet presentation as guidance; the screenshots do not request unrelated Telegram tabs or functionality.

### Acceptance checks
- Select an image without sending; open and close its preview, then remove it or send it successfully. Cover multiple attachments, unsupported preview types, and resource cleanup when a draft attachment is removed or replaced.
- Verify pill curvature, long filenames, removal controls, and absence of the redundant right-side type label in sent bubbles on desktop and mobile widths.
- Verify File selection accepts a non-image document on mobile, while Gallery still selects images. Canceling either picker keeps the draft intact; selecting the same file again works after removal.
- Check keyboard/touch accessibility, sheet dismissal, viewport containment, and regressions in existing attachment upload/preview tests. Clearly state which real mobile/browser checks could not be run.

Status: requested only; no implementation or cause diagnosis yet.

## factory · plan · 2026-11-14 08:43
Behaviour: Draft images preview locally before sending, including before upload completion and without a topic ID; closing, navigating, removing, retrying and switching drafts preserve the draft and discard stale preview loads. Unsupported previews show an error. Draft and sent file pills use full composer-like rounding; sent pills omit only the redundant type label. On touch screens Upload files offers Gallery (images) and File (documents); cancellation preserves drafts and desktops retain direct file selection.

Scope: Existing composer, preview dialog/state, sent file pills, host picker contract and mobile adapter, localized labels and regression tests. Preserve upload validation, limits, multi-selection and FT107 bubble corners. No private storage enumeration or unrelated Telegram functionality.

Decisions: Reuse existing dialogs and picker APIs. Use host-owned local image previews without revoking their URLs; own and revoke pasted-file URLs separately, and retain server fallback for uploaded files. Use pinned nsh 0.5.0 document picker rather than the obsolete photo-only adapter. No dependency or configuration changes.

Checking: Cover unsent previews, multiple files, stale async loads, removal and URL ownership, unsupported types, failure/retry and release on send; check pill rendering, picker dispatch/cancellation/reselection and mobile sheet behavior. Run configured Go checks, nsh check and the full nsh suite with a throwaway HOME; explicitly record real device/browser gaps.

## factory · 2026-11-14 08:43
Built and pushed commit dcd7ad9f on factory/FT110-attachment-preview-pill-style-and-mobile-file-picker. Moved new/ → review/ (round 1).

Implemented local draft image previews with explicit URL ownership and lifecycle cleanup, fully rounded draft/sent pills without redundant sent type labels, and a rounded Gallery/File attachment sheet using nsh 0.5.0 photo/document pickers with web input fallback. Added 11 attachment regression tests and updated existing bubble/composer tests and English porting documentation.

Installs: none; no dependency manifests, lockfiles or configuration keys changed. Verification used the repository-required nsh 0.5.0, not the machine-default 0.4.0.

Tests: configured `test -z "$(gofmt -l .)" && go vet ./... && go test ./...` passed independently. `nsh check` passed. Full `nsh test --web-host tests/noHost.js`: 927 passed, 1 failed out of 928. Failing test: `chat-composer-drum.test.tsx:53: android typing turns the drum to Send — expected 0 to be 1`. Focused retry reproduced it once, then passed all 6 tests twice. The unchanged base 6fc9d38c reproduced the same linux/android assertion in 1 of 6 focused runs; this is a pre-existing intermittent failure, deliberately not fixed on this branch. Review must see the non-green full suite.

UI checking: coder inspected headless Chrome screenshots/computed radii, containment and interactions at 390 and 1280px. Real Android hardware/emulator, actual native Gallery/document selection, real phone browser and desktop app window were NOT checked. The preview dialog/images were exercised in headless tests, not visually inspected in Chrome. Owner should check real phone pickers and preview rendering.

## factory · review · 2026-11-14 09:12
head: dcd7ad9f6bc006d6ded1b2a36da2b8d0331614c0
verdict: fix
fix:
- [P1] web/console-nsh/tests/chat-composer-drum.test.tsx:53: required full nsh suite fails intermittently after clearing the composer (expected drum count 1, actual 0). Obtain a green required suite and address the timing-sensitive test independently of attachment behavior; do not change unrelated production behavior to mask it. This is a pre-existing test-gate failure, not an introduced FT110 code defect.

Validation: Claude Code reviewed origin/master...HEAD (master snapshot 75eec416bc30834943e2297cb4d6cfe83299bfce); no introduced P0/P1/P2/P3 code defects found. Configured gofmt/vet/go test gate passed (exit 0). nsh 0.5.0 check passed. Full nsh test --web-host tests/noHost.js failed: 927 passed, 1 failed of 928; linux drum assertion at line 53 expected 0 to be 1. Focused reruns failed 2/8 on HEAD (android/linux) and 3/8 on unchanged base 6fc9d38c (android), confirming pre-existing intermittency. All 11 new attachment tests passed. Per factory policy a failing required test is P1 even when pre-existing.

Installs: none. No worktree changes or commits by reviewers. Real Android Gallery/document pickers, real mobile browsers and desktop app window were not checked; preview rendering was not visually inspected. Headless tests do not prove native picker behavior or real-device rendering.

Moved review/ → new/ at round 1 of 3 for the next fix round. No linked GitHub issue or PR in the owner request; no GitHub review comment required.

## factory · plan · 2026-11-14 23:04
Fix-round addition: preserve all attachment behavior and fix the review's pre-existing animation-test race in the test fixture only. Hold animation completion explicitly, assert the intermediate drum and target for Linux/Android, release it and await settled controls. Preserve reversal, Stop and reduced-motion coverage. Run repeated focused tests, full nsh checks and configured Go gate. No unrelated production fixes.

## factory · 2026-11-14 23:04
Built fix round 2 with Claude Code and pushed 6f9cc66ad561ad37d7e0624c479b709a0e214c28. Moved new/ → review/.

Recovered a stopped build: retained merge ed726bc6 and inspected relevant uncommitted changes in PORTING.md, chat-composer-drum.test.tsx and fixtures/voice-control-app.tsx; committed them as 60badfc4. Nothing discarded. Merged current origin/master f9e8da5e cleanly in 6f9cc66a; no rebase.

Fixed headless animation-completion scheduling race using fixture hold/release gates and explicit target assertions, retaining intermediate and settled-state checks. Added English timing guidance. No production attachment behavior, dependency manifests or config changed. Installs: none; existing pinned nsh 0.5.0 used.

Tests on pushed head: nsh check passed; full nsh test --web-host tests/noHost.js passed, 939/939 (18m25s); configured gofmt/vet/go test gate passed and was independently rerun by manager successfully. Focused drum test passed 15/15 fresh runs, 6 tests each. Earlier stopped-build logs showed 40/40 new-test passes, not rerun as part of that count. No remaining failing gate.

Not checked: real Android Gallery/document pickers, real phone browsers, desktop app window or visual preview rendering this round. Owner should inspect actual mobile picking and preview rendering; headless tests do not establish native behavior. No unpinned installs. New parallel test script was not run; required direct full-suite command was run.
