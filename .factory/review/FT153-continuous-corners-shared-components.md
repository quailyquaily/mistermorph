---
branch: factory/FT153-continuous-corners-shared-components
round: 1
---
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

## factory · plan · 2026-11-19 01:20
Behaviour: All shared non-circular Console controls and their interactive surfaces use native nsh borderCurve continuous. Circles and switch thumbs stay circular. First-run, empty, error and disabled controls keep behavior; screen-docked panels keep attached edges square. Borders/focus/shadows must follow the same shape without global clipping.
Scope: Central theme radius tokens (controls 8, cards/menus/popovers 12, dialogs 18, switch tracks 6), shared component styles, equivalent direct nsh/base consumers where needed, preview and focused regression tests. No backend, dependencies' source, unrelated design changes or custom SVG/CSS corner machinery.
Decisions: Follow AGENTS nsh 0.6.0 (installed 5541637), not stale factory 0.5 rule. First prove the installed native property and web renderer support; if unavailable identify concrete gap instead of claiming completion. Derive nested menu radii from outer radius and inset. Preserve sizes/spacing and genuine circular variants. Keep existing generic radius compatible where possible; use semantic tokens for differing categories. Inspect UI-kit and direct consumers rather than blanket replacement.
Checking: Test shared styles/property forwarding and actual renderer support; representative controls, overlays, light/dark, narrow/wide, keyboard focus and long content. Update shared preview. Run nsh check and only the required parallel scripts/test.sh suite (failed files retry individually). Run configured gofmt/vet/test gate. Known base gofmt issue at internal/proctrack/proctrack_test.go:210: confirm and report separately; do not fix unrelated Go code. Attempt actual visual checks with available renderer tooling, distinguish headless inspection from visual verification and explicitly report missing desktop/mobile/device checks.

## factory · 2026-11-19 01:20
Built commit 7e74da52 on factory/FT153-continuous-corners-shared-components. Shared semantic corner tokens and native nsh corner-squircle (borderCurve continuous) now cover shared controls, fields, switch tracks, cards, menus/popovers, dialogs and direct base consumers. Added preview, documentation, fixture and 11 regression tests. Circles and attached square panel edges preserved; existing square switch thumbs use nested 3pt corners, circular slider thumb unchanged. No prohibited paths changed.

Decisions/limitations: installed nsh 0.6.0 5541637 core supports the property. Chromium web runtime maps it to corner-shape superellipse(1.7); unsupported browsers fall back to ordinary rounded corners. Native GPUI 0.6.0 explicitly renders circular corners, so smooth curves are NOT delivered on that renderer: concrete upstream renderer gap documented in docs/console/corners.md. Android 0.6 runtime unavailable. Visual browser checks used installed 0.5.1 web runtime with the same corner implementation, not a 0.6.0 web runtime. Loading beam remains a circular-path approximation. Small tags/tooltips, composer pills, chat bubbles and page-specific Contacts cards retain their existing treatment; reviewers should check this scope against the owner's all-controls request.

Tests: nsh check passed; required parallel scripts/test.sh passed 140 files, 0 failed in 247s, including gallery inventory. go vet ./... and go test ./... passed; manager independently reran both and nsh check. Configured combined gate fails after one coder retry: `gofmt -l .: internal/proctrack/proctrack_test.go`. Manager confirmed the identical extra blank line at line 210 in base 8d217db4. No Go files changed; unrelated baseline formatting deliberately left unfixed.

Visual checks reported by coder: Chrome 157 screenshots at desktop 1100px and touch-width 390px; resting/hover/focus, menus/select/dialog and long values; computed corner-shape checked. Fixture only, not full running Console. No independent dark appearance (app forces light and dark palette matches light). Not visually verified on native desktop, Android/iOS devices, Safari/Firefox, or actual nsh 0.6 web runtime. Headless tests inspect classes/layout/interaction, not actual rendered corner shape.

Installs: none; no dependency manifest/lock changes. Initial branch push needed command-local credential.useHttpPath=true, then succeeded. Review should prioritize renderer/platform gaps, coverage of page-specific surfaces and the pre-existing failing formatting gate. No linked GitHub issues or PRs.
