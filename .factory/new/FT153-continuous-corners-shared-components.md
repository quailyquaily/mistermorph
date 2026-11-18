# Continuous corners across shared Console components

## factory · 2026-11-19 00:10
Owner request from Console:

> I like this smooth corner. I'd like to apply this to all non-circle buttons, switches, input, textarea, cards, popup dialogs, menus.
> Nice, use the borderCurve: "continuous". Add this task to new/.

Use nsh's `borderCurve: "continuous"` for a consistent smooth-corner treatment throughout the current Console (`web/console-nsh`), not the retired Vue console. Apply through theme tokens and shared components rather than scattered per-page overrides.

Acceptance criteria:
- Verify the installed nsh version and web renderer support and actually render `borderCurve: "continuous"`; use that native property rather than custom SVG masks, clipping machinery, or a parallel CSS corner implementation. If renderer support is missing, identify the concrete dependency gap rather than silently claiming standard rounded corners satisfy this request.
- Cover all non-circular buttons, switch tracks, inputs, textareas, cards, popup dialogs, menus, and popovers, including their interactive backgrounds. Preserve genuinely circular controls and circular switch thumbs.
- Starting radius scale: 8px for buttons/inputs/textareas, 12px for cards/menus/popovers, 18px for dialogs, and 6px for switch tracks. Keep these centrally defined and adjust only where actual component dimensions require it. Derive nested menu-item radii from the outer radius and inset; screen-docked panels retain square attached edges.
- Preserve existing colors, typography, spacing, control sizes, behaviors, and accessibility. This is a shared corner treatment, not a broader redesign.
- Check borders, focus indicators, hover/pressed/selected fills, disabled states, overflow, and shadows follow the intended shape without clipping content or interactive focus indicators. Avoid global overflow-hidden fixes that break menus or popovers.
- Update the shared-component preview and add appropriate regression coverage. Visually verify representative controls and overlays in light/dark themes on desktop/mobile, including nested corners, long input content, and keyboard focus.

Design reference: the owner's local `smooth-corners-demo.html` demonstrates the desired smooth appearance; it is a visual reference, not a requirement to adopt its CSS implementation. The approved implementation is nsh `borderCurve: "continuous"`.
