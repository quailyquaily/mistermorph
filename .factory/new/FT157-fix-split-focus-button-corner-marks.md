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
