# Mobile contact cards: at least three cards per row

## factory · 2026-11-15 01:12

Owner request:
> new UI request, on mobile, at least show 3 cards in one row. Take care of the avatar size and font size.
> Put it to new/

Scope assumption: this refers to the Contacts card grid discussed in this thread, covering both human and agent contacts.

Acceptance criteria:
- On mobile portrait layouts, display at least three contact cards per row without horizontal page overflow.
- Adjust card spacing, padding, avatar dimensions, and font sizes together so the three-column layout remains readable and usable.
- Long names and other card text must stay within their cards, using appropriate wrapping or truncation without breaking the grid.
- Preserve contact selection/navigation, existing information and accessible interaction targets; do not change desktop layout unnecessarily.
- Verify narrow mobile widths (320, 360, 390, and 430 CSS pixels), including long names and missing avatars, for both contact types.

Request recorded only; not implemented.
