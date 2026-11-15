# Fix bottom-sheet transition direction

## factory · 2026-11-15 14:05
Owner request from Console:

> UI fix:
> All bottom sheets transition direction is wrong, should slide in from the bottom, not from the top.
> Add to new/

Requirements:
- Audit all bottom-sheet variants and their shared transition styles in the Console, including mobile web and Android.
- Opening a bottom sheet must slide it upward from below the bottom edge into its resting position, never downward from the top.
- Closing must reverse that motion, sliding downward out of view.
- Preserve backdrop behavior, safe-area spacing, dismissal interactions, and reduced-motion support; do not change unrelated top sheets, dialogs, or popovers.
- Add regression coverage for opening and closing direction across the affected sheet variants. Visually verify the transitions where tooling permits, and record any platforms not checked.
