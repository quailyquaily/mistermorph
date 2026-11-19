# Match selected bottom-nav icons to the primary button color

## factory · 2026-11-19 19:46
The owner confirmed that selected bottom-navigation icons should use the same theme color as primary button backgrounds and requested adding this task to new/ for the factory to implement.

### Current behavior
- In `web/console-nsh/components/frame/MobileBottomNav.tsx`, selected navigation icons use the `blue` theme token.
- In `web/console-nsh/theme.json`, `blue` is `#426f9e`, whereas `primary` is `#284e78`; primary buttons use `bg-primary`.
- Consequently, selected bottom-navigation icons appear lighter than primary button backgrounds.

### Required behavior and scope
- Use the semantic `primary` theme token for selected bottom-nav icons rather than `blue` or a hard-coded hex value, so their color follows the primary button background as themes change.
- Inspect active primary-page and More navigation states and apply the same selected-icon rule wherever applicable.
- Preserve inactive, disabled, warning/error, and other unrelated icon colors and behavior. Do not globally change the `blue` token or primary button styling.
- Preserve navigation, layout, touch targets, and existing transitions.

### Verification
- Add or update focused regression coverage for the selected/unselected token choice using the repository's existing test conventions.
- Run the configured repository checks and required Console checks/tests.
- Visually compare selected bottom-nav icons with primary buttons in supported themes and navigation states where feasible. Explicitly report any visual checks not performed.
