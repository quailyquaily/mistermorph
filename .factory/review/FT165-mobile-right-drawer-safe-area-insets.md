---
branch: factory/FT165-mobile-right-drawer-safe-area-insets
round: 1
---
# Keep mobile right-side drawers clear of system bars and cutouts

## factory · 2026-11-20 09:30
Owner reports that most right-side panels in the mobile app overlap the system status bar and requests a fix.

### Required behavior
- Apply mobile safe-area insets to right-side drawers so headers, close controls, content, and bottom actions remain clear of the status bar, navigation bar, and display cutouts in portrait and landscape.
- Cover the shared SidePane (Settings detail panes, channel settings, Audit details, and other consumers) and the separate Skill Store detail drawer. Reuse the existing chat topic/workspace drawer's inset handling where appropriate; avoid adding duplicate padding to drawers that already handle it.
- Keep drawer backgrounds edge-to-edge where intended, while keeping interactive content inside the safe area. Preserve scrolling, sizing, and on-screen keyboard behavior.
- Preserve desktop layout and mobile-web behavior; use the application's existing native/CSS inset sources rather than hard-coded status-bar heights.

### Investigation context
- Prior Claude code inspection identified missing inset handling in `web/console-nsh/components/ui.tsx` (SidePane) and `web/console-nsh/pages/skills/SkillStorePage.tsx`; `web/console-nsh/pages/chat/WorkspacePanel.tsx` provides an existing working pattern. Verify current code before implementing.
- Android overlap was identified from code, not a device test. iOS behavior has not been verified; inspect its inset path and explicitly report any remaining verification gaps.

### Acceptance checks
- Add regression coverage for shared and separate drawer inset handling, zero/nonzero safe areas, and avoiding double padding.
- Check Settings (including channel details), Audit details, Skill Store details, and the existing workspace drawer for readable headers, usable close buttons, scrolling, and reachable bottom controls.
- Check portrait/landscape, system navigation modes, keyboard open/closed, and desktop regressions. Record which native/device scenarios were actually tested; do not claim device verification from source inspection alone.

## factory · plan · 2026-11-20 10:57

Behaviour: Mobile right-side drawers keep their backgrounds edge-to-edge while padding their interactive/content region by existing platform-aware safe-area values. Insets react to orientation and keyboard changes. Zero insets remain zero; do not pad desktop columns or duplicate frame/workspace insets. Preserve drawer close, scrolling, content height, and actions.
Scope: Shared SidePane sheet, separate Skill Store sheet, minimal shared inset utility/component changes if required, and regression tests. Inspect existing WorkspacePanel pattern and native/web/iOS safe-area ownership before changing it. No unrelated UI redesign or native platform changes unless indispensable.
Decisions: Reuse the existing rightSheetSystemInsets/systemInsets conventions rather than hard-code bar heights. Keep web and desktop behaviour unchanged. Resolve platform-specific ownership from current code; report iOS gaps rather than claim inspection is a device test. Use one inset owner per drawer, retaining existing flex/scroll layout.
Checking: Cover shared/separate drawers with zero/nonzero insets, landscape sides, keyboard handling, and no double padding; retain workspace regression coverage. Inspect Settings/channel/Audit consumers and Skill Store actions for scroll constraints. Run nsh check, scripts/test.sh, and factory Go checks. Explicitly distinguish automated layout/source tests from visual/native-device checks not performed.

## factory · 2026-11-20 10:57

Built commit `4951f19ef76fc95ae58216d1efdef59e3b8bff01` on `factory/FT165-mobile-right-drawer-safe-area-insets`.

Changes: shared SidePane and Skill Store sheet use one rightSheetPopupStyle inset owner; WorkspaceSheet reuses it. Content takes native top/right/bottom safe areas once; paper stays edge-to-edge. Desktop columns and mobile web remain unchanged. Skill Store retains its own card gaps in addition to system insets. Added drawer fixture and 20 regression checks, workspace assertions, inventory entry and PORTING notes.

Decisions: include iOS safe areas because its sheet overlays the full surface. Android sheet window already shrinks above keyboard, so remove duplicate keyboard-height padding; iOS retains bottom inset because nsh lifts its panel. These keyboard assumptions were inspected in native source, not verified on devices. Possible residual Android keyboard gap remains a review/device-check concern. iOS frame inset ownership outside the drawers was deliberately not changed.

Installs: none.

Tests: required gofmt/vet/go test command passed, independently rerun by manager. nsh check passed (nsh 0.6.0). Required parallel Console runner final run: 149 files, 0 failed, inventory gate passed; eight parallel failures passed solo retries. Initial run failed the missing SkillStoreSheet inventory entry, which was fixed before the passing rerun. New drawer tests: 20/20; removing SidePane fix causes 8 failures.

Verification limits: UI changed but not visually inspected in a browser or native device/emulator. Insets/navigation modes/cutouts/landscape simulated in headless tests, not device verified. No actual Settings/channel/Audit/Skill Store content walkthrough. Software keyboard handling arithmetic/source inspection only; no real keyboard check. iOS runtime unavailable on Linux, no iOS build/device verification. Live inset rotation unavailable in headless engine; separate launches tested landscape values. Owner/reviewer should inspect drawer close/header, scrolling and bottom actions on real pages, Android keyboard behavior, and iOS portrait/landscape.
