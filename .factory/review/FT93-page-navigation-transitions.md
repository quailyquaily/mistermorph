---
branch: factory/FT93-page-navigation-transitions
round: 1
---
# Add directional page and bottom-navigation transitions

## factory · 2026-11-11 13:50
Recorded from the owner's UI fix request.

Request:
> And we should add transitions for all page switching, for example, when entering or going back to the page, use the slide in and out, when switching pages on bottom nav, use the scrollable-tiling like transition.

Acceptance criteria:
- Audit page navigation and apply consistent transitions: entering a nested page slides it in from the right; going back reverses the motion, sliding it out to the right and revealing the previous page.
- Bottom-navigation switches use a horizontal, adjacent-page sliding transition, like a scrollable strip of tiles. Direction follows tab order; outgoing and incoming pages move together rather than fading or animating as dialogs. This request does not require adding swipe-to-navigate gestures.
- Cover navigation via page controls, bottom tabs, browser history, and Android back where supported; avoid animating initial load as a back/forward action.
- Keep outgoing content mounted through exit without duplicate interactive controls; handle rapid navigation, cancelled transitions, loading/error states, and viewport changes without stale pages or blank frames.
- Preserve route/history semantics, per-page scroll behavior, focus/accessibility, bottom-nav positioning, keyboard and safe areas. Respect reduced-motion preferences with immediate or reduced-motion switches.
- Use shared navigation transition handling; coordinate with FT91's dialog transitions without treating sheets as pages.
- Add regression tests for forward/back direction, tab-order direction, rapid switches, and reduced motion. Verify mobile web and Android visually, plus desktop non-regression; explicitly record any platform not checked.

Implementation: Claude Code only; do not use Codex.

## factory · plan · 2026-11-11 20:22

### Behaviour
Initial route renders without motion. Nested forward navigation slides the incoming page from the right; back reverses it. Top-level tab changes move outgoing and incoming pages together horizontally according to navigation order. Apply at committed navigation, including history and Android back, never while guards are pending or cancelled. Outgoing content survives exit but is inert; rapid changes cancel obsolete exits. Reduced motion switches immediately. Loading/error pages use the same frame.

### Scope
Shared router transition metadata and page transition host, platform/history and back integration where necessary, regression tests. Preserve page reuse and scroll behavior; do not animate dialogs/sheets as pages or merge FT91. No swipe gestures, workflow/configuration or backend changes.

### Decisions
Use existing nsh motion primitives and shared navigation ordering; keep transitions brief. Route-aware page instances must not have outgoing pages react to incoming route data. Preserve existing per-page state when a parameter changes in place; handle nested navigation inside shared page components explicitly if needed. Cancel on resize and reduced-motion changes to avoid stale frames. Keep shell/navigation geometry outside sliding content. No initial-load motion.

### Checking
Add direction, tab order, history/back, rapid-switch/cancellation, reduced-motion and outgoing-content lifecycle tests, including same-page nested routes. Run nsh check and nsh test --web-host tests/noHost.js; run configured Go formatting/vet/tests with throwaway absolute HOME. Inspect mobile web, Android and desktop when available; explicitly report unavailable visual checks.

## factory · 2026-11-11 20:22

Built in commits 224d45fa and 4d626689 on factory/FT93-page-navigation-transitions. Shared navigation order/history motion, page and pane stacks provide phone forward/back slides and paired tab movement. Outgoing content remains mounted, non-interactive and route-scoped; rapid switches, resize and reduced motion clear obsolete transitions. Nested list/detail panes covered. No FT91 merge or sheet changes.

Decisions: 280ms horizontal phone slides; wide layouts retain their existing rise entrance. First render and same-page data changes do not slide. Nested item opening within the 0.5s page arrival window skips a second slide. Review should check these scope choices against the requested consistent page switching. Ten existing tests now await outgoing exit. Related Memories deep-link blank frame and outgoing-pane remount defects fixed.

Installs: none; no manifest or lockfile changes.

Tests: configured gofmt/vet/go test command passed both coder and independent manager verification. Coder reports nsh check passed and full nsh test --web-host tests/noHost.js: 653/653 passed. Regression coverage includes navigation direction/order, history replay, rapid changes, reduced motion, outgoing lifecycle, nested panes and cancelled leaves.

Visual checks reported by coder: mobile web Chrome 390x844 and desktop web Chrome 1280x800, with sampled animation frames and screenshots. Android device/emulator and desktop GPUI window NOT visually checked (unavailable); Android headless tests only. One headless Android voice test tap on a final transition frame needed waiting; Chrome taps at 0–400ms worked. Review should scrutinize transition-time input handling. FT91 integration not visually checked.

Manager verified clean worktree, item-only commits and no forbidden-path changes. Branch push succeeded after retry with command-local credential.useHttpPath=true. Moved new/ → review/, round 1.
