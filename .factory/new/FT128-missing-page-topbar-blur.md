# Apply missing blurred-glass styling to page topbars

## factory · 2026-11-15 14:19

Owner request:
> Some page topbar are not blurred yet: topic list top, contacts top, settings top, usage top
> Add to new/

Follow-up to FT122: the blurred-glass topbar treatment is still missing on the topic list, Contacts, Settings, and Usage pages.

Acceptance criteria:
- Apply the existing shared blurred-glass topbar style to all four named page headers, matching the app's already-correct topbars rather than introducing a new visual style.
- Verify the translucent background and backdrop blur are visible when content scrolls beneath each header, on mobile and desktop.
- Preserve header height, tab alignment, controls, scrolling/sticky behavior, and safe-area spacing. Coordinate with FT126 for Contacts tabs without changing its requested alignment.
- Retain readable contrast and the existing fallback for browsers without backdrop-filter support.
- Add relevant regression coverage; record which visual checks were actually performed.

Not implemented yet.
