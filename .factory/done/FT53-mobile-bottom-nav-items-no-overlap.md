---
branch: factory/FT53-mobile-bottom-nav-items-no-overlap
round: 1
---
# Mobile bottom navigation items must not overlap

## factory · 2026-11-10 00:41
Owner request: "New UI fix: mobile view bottom nav's items, do not overlay."

Fix the mobile bottom navigation layout so its items do not overlap each other. Keep icons, labels, and touch targets distinct and usable at narrow mobile widths, in both the mobile browser and Android app.

Acceptance criteria:
- Navigation items have separate, non-overlapping bounds; icons and labels do not collide or obscure adjacent items.
- All navigation destinations remain visible and tappable, including the active item; do not solve the problem by hiding destinations.
- Respect bottom safe-area insets and preserve existing navigation behavior and desktop layout.
- Check narrow mobile widths (including 320px and 360px), portrait/landscape, and increased text size. Add regression coverage for the layout where supported.
- Report visual checks performed and explicitly identify any Android-device checks not performed.

Queued UI fix only; not implemented yet.

## factory · plan · 2026-11-10 03:46
Behaviour: Give each primary destination, More and agent a separate equal-width region, including the active highlight. Preserve icon-only navigation, accessibility labels, tooltips, menu behavior and bottom safe-area spacing. All five destinations remain tappable at 320px.
Scope: Mobile bottom navigation geometry and focused regression tests; no desktop redesign or navigation changes.
Decisions: Remove the intentional negative-margin overlap. Share available width equally with a 60px slot cap; use the same geometry for the active highlight. Retain existing height and icon sizing.
Checking: Assert separate slot bounds at 320/360px, narrower display-size approximation and landscape/rotation, and exercise every button. Run Go formatting/vet/tests plus Console check and tests. Record visual/device limitations explicitly.

## factory · 2026-11-10 03:46
Built and pushed commit 7a268a8d3b6a48fff957f3f47c9beccf615f7010. Removed overlapping slots, sized each to available strip width, and aligned the active pill with the same geometry. Added real-component layout fixture checks at 320, 360, 288 and landscape widths, rotation coverage, and all-button navigation at 320px.
Manager verification: formatting check, go vet ./..., go test ./..., nsh check and nsh test --web-host tests/noHost.js all passed (352/352 Console tests). Changed paths are limited to the component, geometry helper and three test files; no protected paths changed.
Installs: no unpinned tool/dependency installs found; no dependency manifests changed.
Not checked: no visual browser inspection, Android device/emulator run or Android package build. The 288px test approximates display-size/zoom only; actual increased system font size was not checked.
Process deviation: coder reported scratch artifacts outside the assigned build directory; these are not committed. Verification tests run by the manager used a throwaway HOME within the build directory.
Moved new/ → review/. Owner should inspect narrow-screen layout, larger system fonts and Android rendering during acceptance.

## factory · review · 2026-11-10 03:59
head: 7a268a8d3b6a48fff957f3f47c9beccf615f7010
verdict: pass
notes:
- Codex reviewed origin/master...HEAD against the request and plan; no actionable P0-P3 findings.
- Required formatting, go vet ./... and go test ./... passed; 162 test packages passed and 19 had no tests. Console nsh check passed; nsh test --web-host tests/noHost.js passed 352/352.
- Automated coverage includes 320/360/288 widths, landscape, rotation and all five navigation targets at 320px. Safe-area logic and desktop conditions are unchanged.
- No browser visual inspection, Android device/emulator run, APK build or actual increased system font-size check. Highlight assertions verify computed coordinates, not final rendering. Supplemental web packaging failed because the local web runtime was unavailable; required checks passed.
- No installs or code changes. Tests used a throwaway HOME within the review directory. Review worktree remained clean.
- Moved review/ → ready/. Owner acceptance should check narrow-screen visuals, larger system fonts and Android rendering before shipping.

## factory · 2026-11-10 07:47
Merged into master: afcb097b. Released with tag v0.3.91 at afcb097b; master and tag pushed atomically.
Combined validation passed: gofmt check, go vet ./..., go test ./..., nsh check, nsh test --web-host tests/noHost.js (364/364), nsh build, and git diff --check. Scripted tests used an absolute throwaway HOME. No unpinned installs. No linked issues or PRs to close.
Not verified: real-device Android/mobile keyboard, touch gestures, system font-size and final visual appearance; no APK packaging or release CI validation in this ship run.
Moved ready/ → done/.
