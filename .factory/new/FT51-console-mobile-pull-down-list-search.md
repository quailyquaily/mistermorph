# Reveal mobile topic and contacts search by pulling down the list

## factory · 2026-11-10 00:38
Owner request: On mobile, the search boxes on the topic and contacts pages should not show by default. Like Telegram search, reveal search when the user swipes down the list, at the top of the list. Search belongs in the list container, not the column 2 topbar alongside plus buttons and tabs.
Requested status: new/.

Acceptance criteria:
- On mobile, hide search initially on both the topic list and contacts list.
- A downward pull when the list is at its top reveals the search field at the top of that list, following the Telegram-style interaction described above; ordinary scrolling back toward the top must remain usable.
- Place mobile search within the scrollable list container, not the column 2 topbar. Keep plus buttons and tabs in their existing topbar positions.
- Preserve existing search/filter behavior, clear controls, focus usability, and empty/no-results states. Search must remain reachable for short and empty lists.
- Preserve desktop search placement and behavior; use existing design styling and mobile safe-area conventions.
- Add focused regression coverage where practical and check touch scrolling and keyboard interaction on mobile; record any device or visual checks not performed.

Registered only; not diagnosed, implemented, or visually verified.
