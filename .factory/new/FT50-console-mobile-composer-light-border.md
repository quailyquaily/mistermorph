# Add a subtle design-consistent border to the mobile composer

## factory · 2026-11-10 00:31
Owner request (mobile views): "The composer should have a light border, fit our design."
Requested status: new/.

Acceptance criteria:
- Give the mobile composer a subtle visible border consistent with existing design tokens, shape, spacing and supported themes.
- Preserve focus and disabled states, input sizing, multiline growth and button alignment; avoid layout shifts.
- Check narrow mobile widths with the keyboard both open and closed; do not introduce unrelated desktop styling changes.
- Add focused regression coverage where practical; record any mobile/device checks that could not be performed.

Registered only; not diagnosed, implemented, or visually verified.
