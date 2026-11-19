# Polish the plus focus button's corner marks

## factory · 2026-11-19 14:38
Owner request from Console:

> The new curved-corner buttons are great, but the plus focus button still has two L-shaped marks around it that do not use curves like the button. Polish these and add to factory new/.

### Requirements
- Locate the plus focus button shown in the owner's screenshot: a filled blue plus button with detached top-left and bottom-right L-shaped corner marks.
- Replace the sharp right-angle joins on those two marks with smooth continuous corners visually consistent with the button's new `borderCurve: "continuous"` treatment. Keep them as two open corner marks, not a full outline or extra button background.
- Use the shared corner treatment where supported. Verify that the actual rendered marks curve correctly; merely setting a property without affecting their visible stroke is insufficient.
- Preserve the marks' balanced offset from the button, stroke weight, color, alignment, and existing state/animation behavior. Avoid clipping at supported sizes and mobile widths.
- Do not change the plus icon, button action, hit target, accessible name, or keyboard focus visibility. Keep this a focused visual polish rather than a redesign.

### Acceptance / coverage
- Both marks visibly follow smooth curves rather than square L joins, with consistent spacing relative to the button in all states where shown.
- Check normal, hover, focus, and pressed states where applicable, mobile/desktop layouts, and light/dark themes. Preserve any reduced-motion handling.
- Add appropriate regression coverage using the existing Console component/test conventions and verify the rendered result visually.
