---
branch: factory/FT154-scrollable-tabs-mobile-workspace-picker
round: 1
---
# Scrollable tabs in narrow layouts and mobile workspace picker

## factory · 2026-11-19 14:34
Owner request from Console:

> The tabs component needs to scroll when long tabs overflow a narrow space. On mobile, the workspace picker dialog's sidebar Places items can become tabs. Users should be able to drag/swipe the tab strip horizontally, or select a tab and have it scroll into the right position.

### Requirements
- Add reusable horizontal overflow scrolling to the shared tabs component. Preserve existing non-overflow behavior and prevent tabs from expanding the page or dialog beyond the available width; retain readable labels instead of squeezing all tabs to fit.
- Support touch swipe/drag scrolling of the tab strip (including a press-and-drag gesture). Distinguish scrolling from tapping so a drag does not accidentally activate a tab. Preserve normal vertical page/dialog scrolling where appropriate.
- Clicking or tapping a tab selects it and scrolls it into view using the nearest necessary position. Keep the selected tab visible after keyboard selection, initial rendering, and viewport/layout changes, without unnecessary jumps. Respect reduced-motion preferences.
- In the mobile workspace picker dialog, replace the Places sidebar navigation with these horizontal scrollable tabs. Keep the desktop sidebar layout and existing place selection/content behavior unchanged.
- Preserve tab semantics, accessible names, visible keyboard focus and keyboard navigation. Do not make scrolling the only way to reach an item.

### Acceptance / coverage
- At narrow mobile widths with many or long place labels, the strip scrolls horizontally and does not cause document/dialog overflow or truncate access to later tabs.
- Swiping/dragging reaches tabs on both ends without unintended selection; tapping an item selects it and reveals the full tab when it fits the viewport.
- Check keyboard selection/focus visibility, initially selected offscreen tabs, viewport resize, and unchanged desktop workspace picker navigation.
- Add regression coverage for overflow/selected-tab visibility and mobile Places navigation using the existing component and Console test conventions.

## factory · plan · 2026-11-19 15:32

Behaviour: Shared Tabs remain unchanged when options fit. When labels exceed available width, retain intrinsic readable option widths in a bounded horizontal strip; support swipe and press-drag without firing selection after a drag. Vertical gestures should retain normal vertical scrolling. Selecting via tap, click or keyboard reveals the selected option using minimal nearest-edge movement. Initial layout, changed items/value and resized viewport reveal selection without redundant jumps. Respect reduced motion and preserve accessible tab roles, names, focus and keyboard reachability. Mobile workspace picker displays Recent/Home/System plus available state/cache places as shared horizontal tabs and keeps existing selection loading/error/empty/create behaviours; desktop keeps its sidebar.
Scope: shared Tabs implementation, narrowly scoped helpers if warranted, mobile WorkspaceDirPickerDialog navigation and regression fixtures/tests. No unrelated UI redesign, generated web builds, dependencies or backend changes unless essential.
Decisions: Use nsh's supported scrolling/gesture/ref APIs rather than DOM-only implementations so native clients work. Preserve equal-width tabs when they fit, overflow rather than crush labels. Keep the existing isMobile breakpoint for picker. Hidden optional places are not tabs. Disabled tabs remain disabled and keyboard navigation skips them; use existing conventions for activation. A tab wider than viewport aligns predictably without oscillating. No places is handled by retaining fixed Recent/Home/System entries.
Checking: Add tests for overflow containment, intrinsic widths, selected-tab reveal on first layout, value/layout/viewport change, touch/drag tap suppression and vertical gesture handling, keyboard/focus, mobile Places content selection and desktop sidebar preservation. Run nsh check and scripts/test.sh, plus required gofmt/vet/go test. Report any gesture/visual/platform behaviour that could not be checked on real devices.

## factory · 2026-11-19 15:32
Built with Claude Code: 98c8603a and a8ce546e. Shared Tabs now preserve label widths, constrain horizontal overflow, support swiping and mouse press-drag without accidental activation, and reveal selected/focused options with minimal scrolling after initial layout, selection and resize. Reduced motion is respected. Mobile workspace Places use shared tabs; desktop sidebar stays unchanged. Added component/picker regression coverage and gallery example; documented runtime limitations in PORTING.md.

Decisions: only overflowing strips instantiate a scroller because the web runtime consumes vertical swipes over any scroller. Equal tabs retain intrinsic minimum label widths. Existing mobile breakpoint and source loading behaviours remain. Tabs remain keyboard Tab stops with Enter/Space activation and visible focus; disabled options are skipped.

Installs: none; no manifest or lock changes.

Validation: coder reports nsh check and nsh build passed; required scripts/test.sh passed all 144 test files (including 16 new tests), with no reruns needed. Manager independently verified clean gofmt, go vet ./... and go test ./... on final commits. No prohibited paths changed, and only this item's commits follow start point 67242667.

IMPORTANT review gap: on the web runtime, a vertical swipe starting over an OVERFLOWING strip is consumed rather than scrolling the surrounding page. Non-overflow strips preserve vertical page scrolling. Headless vertical-gesture coverage does not establish browser behaviour; reviewer should assess this against the requirement and avoid treating all acceptance criteria as satisfied.

Visual inspection: coder inspected screenshots and gestures in Chrome with nsh web runtime 0.5.1; pinned local compiler is 0.6.0 and matching web runtime was not available. Android/iOS/native desktop and real device gesture/focus behaviour were not checked. Headless focus auto-reveal also cannot alone prove browser focus handling.

Pushed branch and moved new/ → review/. Initial credential-helper request lacked repository path; retried successfully with command-local credential.useHttpPath=true, without changing user configuration.
