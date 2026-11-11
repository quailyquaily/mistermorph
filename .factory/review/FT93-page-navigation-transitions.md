---
branch: factory/FT93-page-navigation-transitions
round: 2
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


## factory · review · 2026-11-11 20:50
head: 4d6266895e96ec5db353c4d7e1bd33eb3db6b925
verdict: pass
notes:
- [P2] web/console-nsh/pages/settings/SettingsPage.tsx:135-144: Android Back resets the route to /settings before the outgoing section is held for exit, so System is replaced by Persona during its slide. Reproduced with headless Android: open Settings, open System, press Back; outgoing panel shows settings-persona rather than settings-open-logs. Hold the outgoing section content until its exit completes.
- [P3] web/console-nsh/components/frame/PageStack.tsx:120-125: retained outgoing pages keep active system-back handlers. In a slowed-transition headless Android probe, open Skills weather, switch to Todo, press Back during exit: the outgoing Skills handler consumes Back and the route remains Todo; after exit Back correctly returns to Skills weather. Disable outgoing system-back registrations, not just pointer input.

Validation: Claude Code reviewed origin/master...HEAD. Configured gofmt/vet/go test passed (GATE_EXIT=0); nsh check passed; nsh test --web-host tests/noHost.js passed 653/653. Tests used absolute throwaway HOME. No installs. Review worktree remained clean. The initial coder tool response lost its report, so Claude Code repeated the read-only review and reused completed test logs.

Residual risks: rapid successive slides may expose a blank strip when the obsolete outgoing layer is removed; not reproduced, so not recorded as a confirmed finding. Real Android device/emulator, desktop GPUI and FT91 dialog integration were not visually checked in review. Async outgoing callbacks and duplicate browser-history entries need further coverage. Owner should inspect the two confirmed non-blocking defects and the scope choices: wide layouts retain rise motion and nested opens within 500ms skip their slide.

No P0/P1 findings; moved review/ → ready/ under the configured factory review gate. This is not a claim of no defects. No linked GitHub issues or PRs.

## lyric · 2026-11-11 21:06
嗯 先处理 ft93 的问题，然后合 Ft85,91,86,80,92,93 一起。

## factory · 2026-11-11 21:50
Fix round 2 completed with Claude Code, head 1666f8b4. Fixed both confirmed review notes: retain outgoing Settings section on Android Back; disable outgoing pages system-back handlers via scoped registration. Added five tests, including slowed-slide full-console Android-host regressions; four regression cases fail with fixes reverted. Updated one existing dismissal test to wait for exit. Configured Go gate passed (162 packages); nsh check passed; full Console suite 658/658 passed. First attempt found a missing pinned cached module and an outdated immediate-dismiss assertion; both resolved and full gate rerun. No unpinned installs. Actual Android/emulator, native desktop and live browser visuals not checked. No unrelated P2 fixes. Moved new/ → review/.
