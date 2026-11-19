---
branch: factory/FT157-fix-split-focus-button-corner-marks
round: 1
---
# Fix split curves in the plus focus button's corner marks

## factory · 2026-11-19 19:03
Owner reports a regression in FT155: each of the two curved corner marks around the plus focus button visually breaks into two pieces. The owner approved the continuous-stroke HTML prototype and requested this follow-up in new/.

### Approved reference
- Self-contained prototype: `.factory/references/FT157-continuous-marks-prototype.html` on `factory_board` (copy into the build workspace as a reference if needed; do not merge the board branch into application code).
- Original local prototype: `prototypes/ft155-continuous-marks-fix.html`. The board copy preserves the approved reference for builds on other machines.

### Requirements
- Keep exactly two detached corner marks: top-left and bottom-right. Each mark must be one unbroken, smooth curve, not separate horizontal and vertical pieces with a visible seam or step.
- Follow the approved prototype: one continuous SVG path/stroke per mark, with tangent-continuous joins and a curve following the button's continuous-corner shape. Preserve the approved slightly longer arms rather than simply rounding the old tiny CSS border box.
- Keep stroke weight, color, spacing and symmetry visually consistent; preserve button size, plus icon, interaction, focus accessibility and existing animation/reduced-motion behavior. Decorative SVGs must not intercept pointer events or enter the accessibility tree.
- Do not treat the suspected CSS border rasterization cause as proven: the reported defect was not reproduced in desktop Chrome. The fix must eliminate separately painted border-side joins, not rely on a browser-specific offset workaround.

### Acceptance and checking
- Check actual-size and enlarged rendering in light/dark themes, default/hover/focus/pressed states, narrow layouts, fractional zoom, and representative 1x/2x/3x device pixel ratios. Both marks must remain continuous, balanced and unclipped.
- Add regression coverage using the existing Console component/test conventions for two decorative single-stroke marks and unchanged button behavior. Visually compare the implementation to the approved prototype; report browser/device checks that could not be performed.
- This is a focused follow-up to FT155, not a redesign of other buttons or corners.

## factory · plan · 2026-11-19 19:32
Behaviour: Render exactly two detached decorative SVG marks outside the existing 52pt Fab. Each uses one open continuous path matching the approved prototype's default 22pt arms, 1pt stroke, 5pt outer gap, radius 8+4.5 geometry and tangent joins. Retain all button labels, disabled/click/focus/tooltip, entry/press/reduced-motion behaviour; decorations neither handle pointers nor appear in accessibility. Missing optional icon remains plus; no new loading/error state or persistence.
Scope: Change Fab mark construction and focused geometry/component tests only, plus a tiny geometry helper if justified. Do not redesign button or other corners, theme, or animations. Prototype stays outside committed application code.
Decisions: Preserve actual application's button and its native corner implementation; port only the approved mark geometry, using existing nsh SVG rendering conventions rather than browser-only DOM. Keep 5pt outer extent with sufficient local SVG bounds for 22pt arms and stroke. Use theme token for muted stroke; symmetrical bottom-right geometry. Do not claim border rasterization reproduced.
Checking: Regression tests for exactly two single-path decorations, no border-side drawing, continuous geometry/tangents and approved constants, mark frames and symmetric placement, labels/click/disabled plus reduced-motion and narrow layout. Run nsh check, scripts/test.sh (parallel runner; failing file once alone), and factory Go test gate. Compare actual rendering with approved reference where browser facilities exist; explicitly list unchecked states/device ratios, no fabricated visual checks.

## factory · 2026-11-19 19:32
Built ed05717a12b43847abbf5941bb3dac3ca95f3efc: replaced two separately painted border boxes with two decorative single-stroke Canvas paths, using the approved prototype geometry (22pt arms, 1pt muted stroke, 5pt outer extent, concentric 12.5pt radius). Preserved button, icon, labels, tooltip, press/disabled/focus and motion behaviour. Added geometry, single-stroke, symmetry, layout/accessibility and interaction regressions; updated corner docs and component inventory.

Implementation deviation for review: uses the existing nsh Canvas convention, not literal SVG elements as requested; each mark is one open path and one stroke. Approved prototype constants contain sub-point straight connectors with small internal tangent angle changes (up to 6.2 degrees); preserved those constants with round joins rather than claiming mathematical tangent continuity throughout. Arm-to-curve tangents are exact. Review should assess these differences against the request.

Tests: manager independently passed gofmt cleanliness, go vet ./... and go test ./..., diff --check, scoped commit/path checks. Coder passed nsh check (0.6.0), all 145 parallel Console test files; separate inventory gate initially failed, fixed its listing, then inventory 4/4, ui-components 14/14 and Fab 10/10 passed on targeted rerun. No unpinned installs.

Visual checks reported by coder: headless Chrome, actual-size and 8x comparison, light theme, hover/press/keyboard focus/disabled/reduced-motion, narrow phone layouts, DPR 1/1.25/1.5/2/2.625/3; no split/clipping observed, prototype profile matched. Unchecked: distinct dark theme (current app forced light and identical tokens), real browser zoom (fractional DPR only), real devices/native renderers, Safari/Firefox, nsh 0.6.0 web runtime (Chrome used installed 0.5.1 runtime). Original reported split was not reproduced; no browser-offset workaround used.

Branch pushed. First push credential lookup failed without repository path; command-local credential.useHttpPath=true succeeded on retry. Moved new/ → review/, round 1. No source issue/PR linked.
