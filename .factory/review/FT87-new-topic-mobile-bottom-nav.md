---
branch: factory/FT87-new-topic-mobile-bottom-nav
round: 1
---
# Restore bottom navigation on the mobile new-topic page

## factory · 2026-11-11 13:13
Recorded from the owner’s UI fix request.

Request:
> The new topic page, does not show the bottom nav on mobile view.

Interpretation: the missing bottom navigation is the reported bug; show it on the mobile new-topic page, consistently with other mobile views.

Acceptance criteria:
- Inspect the new-topic route and mobile layout to identify why the bottom navigation is missing.
- Show the standard mobile bottom navigation on the new-topic page, preserving active state and navigation behavior.
- Keep the form and actions usable above the navigation, including safe-area insets and virtual-keyboard behavior; avoid overlap and duplicate navigation.
- Preserve desktop layout and existing topic creation behavior.
- Add regression coverage and check narrow mobile web and Android app layouts. Explicitly record any platform or keyboard behavior not actually checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 15:12
Behaviour: Show the shared mobile bottom navigation on the new-topic view, preserving Topics active state and destinations. Empty first-run forms, pending sends and creation errors must keep controls clear of the floating bar. Preserve desktop and open-topic behavior.
Scope: Inspect route visibility and use shared mobileBarRoom/MobileBarSpacer for clearance; focused regression tests, no duplicate navigation or unrelated UI changes.
Decisions: Reuse existing navigation and safe-area policy; change route metadata only if required. Keep open-topic nav policy unchanged.
Checking: Narrow mobile navigation, active state, destinations, empty/pending/error form clearance, and desktop regression; Android harness where available. Record missing real-device/keyboard checks.

## factory · 2026-11-11 15:12
Built with Claude Code; commit cb68d0e8, based on e41edbcf. Moved new/ → review/.
The missing navigation itself was not reproduced on current master. The reproducible defect was the pending/failed new-topic composer overlapping the existing floating nav, intercepting Send taps. ChatMain now reserves shared MobileBarSpacer room; route visibility and navigation are unchanged. Added optional spacer testID, five regression tests and a PORTING note on headless taps not checking occlusion. Open topics and desktop have no spacer room.
Tests: manager independently passed gofmt cleanliness, go vet ./..., and go test ./.... Coder passed nsh check and all 626 nsh tests (0 failed); 3 of 5 new tests fail without the fix. Coder checked Chrome touch-emulated 390×844, 320×568 and 844×390 layouts, empty/pending/failed forms, active nav, and Send hit-testing. Android checked in headless harness with a 16pt gesture inset and navigation slots.
Installs: none; no dependency or manifest changes.
Not checked: actual Android/iOS devices or emulator, real mobile browser, virtual keyboard, desktop application build, APK rebuild. Keyboard clearance relies on existing frame padding. Very short keyboard-open/landscape layouts may overflow because the centered form is not scrollable; review should examine this against acceptance criteria. Existing global error notices may overlap nav and were left outside scope.
First branch push lacked credential repository-path context; retry with command-local credential.useHttpPath succeeded. No recovery or numbering changes were needed.
