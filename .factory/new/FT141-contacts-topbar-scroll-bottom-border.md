# Contacts topbar: show a subtle bottom border when scrolled

## factory · 2026-11-17 09:33

Owner request:
- When the contacts list is scrolled down, show a light bottom border on its topbar, matching the topic list topbar behavior.
- Apply this to both the column-2 contacts view and the contacts page.
- Align the border exactly with the bottom edge of the topbar.
- Hide the border when the corresponding scroll position returns to zero, just like the topic list.

Scope and acceptance:
- Inspect and reuse the topic list topbar's existing scroll-dependent border treatment where appropriate, matching its color, weight, and transition behavior rather than introducing a different visual treatment.
- Track the actual contacts content scroll container in each layout; show the border for scrollTop > 0 and hide it at scrollTop = 0, including initial render, restored scroll positions, and navigation between views.
- Avoid layout shifts, double borders, and borders offset from the topbar bottom edge.
- Add regression coverage for zero/nonzero scroll transitions in both contacts layouts; verify desktop column-2 and mobile/page presentation.

Requested status: new. Investigation and implementation are pending.
