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
