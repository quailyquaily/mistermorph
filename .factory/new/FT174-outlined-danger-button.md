# Add an outlined danger button

## factory · 2026-11-23 15:18
Owner request:
> outlined danger buttons.

### Where it is
The Console's `Button` (`web/console-nsh/components/ui.tsx`, `ButtonVariant`): today `primary`, `outlined`, `plain`, `danger` (solid red), `highlight` and `ghost-danger` (bare red text). There is no outlined button in the danger colour. `CircleButton` has the same set of looks for round icon buttons.

### Expected behavior
- A new variant, an outlined danger button: the outlined button's box (translucent fill, hairline, corners, sizes) with the danger colour for its hairline and its label or glyph. It is the quieter of two destructive buttons: `danger` stays the solid one for the confirming press, the outlined one is for a destructive action offered beside others.
- Every state the other variants have: hover and focus (a danger tint, not the neutral one), pressed, selected, disabled (its own paler colours, not a plain opacity) and loading (the busy beam in the danger colour, as `danger`'s). As a text button and as an icon button, in every size (`md`, `sm`, `xs`, `xxs`).
- The same in the light and the dark appearance, with the contrast the other outlined and danger buttons keep.
- `CircleButton` gets the matching look if a round outlined danger button is as easy; say so if it is left out.
- Listed in the UI component gallery: the `Button` demo (`/ui-components`) shows the new variant beside the others.

### Decisions left to the build
The request gives no place to use it. Add the variant and its gallery example; where an existing destructive button is clearly the quieter of two (and is `ghost-danger` or `outlined` today), it may take the new variant, but do not restyle destructive buttons across the Console without a reason, and list each one changed. How it relates to `ghost-danger` (keep both, or replace it) is open: keep both unless they turn out to be used for the same thing.

### Acceptance checks
- The variant in every state and size, text and icon, at desktop and phone widths, light and dark.
- Regression coverage beside the existing button tests (looks, the loading state, the disabled colours). Run `nsh check` and `web/console-nsh/scripts/test.sh`.
- Look at it in the running Console's gallery; record any visual check that could not be made.

Scope: the button variant, its gallery example and the few buttons that take it; no redesign of the other variants (the solid buttons' polish is a separate item).
