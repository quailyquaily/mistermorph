---
branch: factory/FT100-agent-switcher-selectable-popup
round: 1
---
# Fix agent switcher selection and reuse the profile-selector popup

## factory · 2026-11-13 00:26
Owner request:
> New UI fix:
> The desktop version agent switch, the avatar drop-down list cannot be selected. But the overview entry works. The agent times do not work. You can use the new popup bubble component(llm profile selector) to re implement it, but the caret direction and popup direction should change 180deg.
> The mobile view can also apply this style, to popup.sa

### Expected behavior
- Fix the desktop avatar/agent-switcher menu: agent entries must be selectable and actually switch to the selected agent. The working Overview entry must keep working.
- Reuse the existing LLM profile-selector popup bubble component/style. Rotate the caret direction and popup opening direction 180 degrees relative to the profile selector, appropriate to the agent-switcher anchor.
- Apply the same popup-bubble style to the mobile agent switcher, with viewport-safe placement and usable touch targets.
- Preserve current-agent indication, labels/avatars, navigation semantics, and closing behavior after selection. Do not change agent data or backend routing.

### Interpretation
- Treat “agent times” as “agent items”: agent rows, contrasted with the working Overview entry.
- Treat the final “sa” as a typing artifact; infer no additional feature.
- Prefer reuse; make only minimal shared-component changes for opposite placement/caret orientation and mobile support.

### Acceptance checks
- Desktop app: select each available agent through the avatar popup and verify the selected agent and corresponding view change; Overview remains selectable.
- Inspect hit testing, layering, and dismissal for lost clicks; determine the actual cause rather than assuming one.
- Verify opposite popup/caret orientation, active-agent indication, repeat switching, outside-click dismissal, Escape, and existing keyboard/focus behavior.
- Mobile: open and select by touch at narrow widths; popup and actionable rows remain visible and usable without clipping.
- Add regression coverage for agent-item selection and Overview navigation, plus applicable popup interaction/placement tests. Run configured repository and Console checks/tests.
- Visually verify desktop and mobile layouts; explicitly record any native-desktop, touch, or visual checks that cannot be performed.

Scope: agent-switcher interaction and popup presentation, plus minimal reusable popup support; no unrelated navigation redesign.

## factory · plan · 2026-11-13 02:06

### Behaviour
- Open the desktop avatar switcher as the existing profile-selector bubble, preferred below its top anchor (profile selector prefers above), with its tail facing the anchor; flip only for viewport safety.
- Online agent selection switches endpoint, closes the popup, and marks the current endpoint; offline rows stay visible and disabled. Overview remains actionable, even when filtering yields no agents. Empty/first-run endpoint lists retain Overview and empty copy.
- Large agent lists retain filtering in the bubble rather than a separate inconsistent modal. Preserve keyboard selection, Escape/outside dismissal, and repeat switching.
- Mobile uses the same bubble presentation at its bottom agent anchor with safe placement, scrolling and touch-sized rows, retaining Overview and current-agent information.
### Scope
AgentSwitcher, MobileBottomNav and minimal shared PopoverPicker extensions and regression tests. No agent/backend data or unrelated navigation changes; preserve labels, avatars, connectivity ordering and disabled offline policy.
### Decisions
Reuse components/shared/PopoverPicker.tsx, including its geometry and tail, rather than another popup. Add only necessary disabled-item/custom-row/footer or row-size support. Investigate why MenuItem rows inside Scroll/Each fail while the direct Overview MenuItem works; document evidence, not assumptions. Preserve externally controlled mobile open state and back/dismiss integration.
### Checking
Add desktop click/repeat-selection/Overview, current/offline/empty/filtering, keyboard dismissal and mobile narrow viewport/touch-target/placement regressions as supported. Run configured gofmt, vet, Go tests plus nsh check and nsh test --web-host tests/noHost.js. Use throwaway absolute HOME for scripted tests while keeping required pinned tool/cache resolution. Inspect native desktop/mobile visually if available; explicitly state unavailable native, touch, or visual verification.

## factory · 2026-11-13 02:06

Built and pushed factory/FT100-agent-switcher-selectable-popup at 0268fdb4a2e3b4e5195d048e19636b83bb69f321; round 1.

Cause: reproduced in the native GPUI test window with the real component: the app-wide Scrollbar.setTheme(SCROLLBAR) made agent rows inside the old Menu's Scroll ignore clicks, while the outside Overview row worked. Disabling that scrollbar/theme restored clicks. Nested Scroll/Each alone was not the cause; browser/headless clicks did not reproduce it. The replacement PopoverPicker works with the theme enabled.

Desktop and mobile now reuse the profile-selector bubble, including geometry and tail. Desktop prefers below with an upward tail; mobile opens above its bottom anchor with 44pt rows. Current agent, avatars, connectivity ordering, disabled offline agents, filtering by name/ref, Overview footer, keyboard selection, Escape/outside dismissal and Android Back are preserved. More than eight agents now filter inside the bubble instead of a separate modal. Minimal opt-in shared picker extensions support disabled/trailing/grouped rows, filter keywords, footer, row sizing and test IDs; width and tail are viewport constrained. Mobile outside taps now dismiss without activating controls beneath the popup, consistent with nsh Popover touch behavior.

Tests: manager independently verified configured gofmt cleanliness, go vet ./..., go test ./...; nsh check; nsh test --web-host tests/noHost.js (819 passed, 0 failed). Scripted checks used an absolute throwaway HOME. The first manager Console invocation exceeded the shell timeout; rerun completed successfully. Regression coverage includes repeated agent switching, disabled offline rows, Overview with empty filtering, filter name/ref, keyboard navigation, Escape, folded sidebar, mobile selection/Overview and Android Back.

Visual checks: coder checked Chrome desktop and 360pt touch emulation, including popup direction, tail, active indication, switching, outside dismissal, offline rows and touch geometry. Native click evidence is simulated GPUI window tests. The actual desktop app with a real display and a real Android device/emulator were unavailable; real-device touch/keyboard behavior was not verified.

Installs: no unpinned installs or manifest changes. cargo fetch --locked restored pinned dependencies for native GPUI probes only. No source issue/PR links. No base push or deployment.
