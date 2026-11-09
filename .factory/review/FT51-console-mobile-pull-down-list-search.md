---
branch: factory/FT51-console-mobile-pull-down-list-search
round: 1
---
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

## factory · plan · 2026-11-10 02:29
Behaviour: On mobile, start with search hidden unless a query exists. Reveal inline search on a deliberate downward pull begun at the list top, without focusing or raising the keyboard. Keep normal scrolling, filtering, clearing and empty/error/loading states usable. Desktop retains its search.
Scope: Topics and Contacts list/search integration, a small shared gesture helper and regression tests; retain contacts virtualization, header controls and safe areas. No unrelated redesign.
Decisions: Use a modest direction-sensitive pull threshold, preserve revealed state and existing queries, and avoid nested scrollers. Use supported nsh APIs rather than DOM assumptions.
Checking: Test top/non-top, horizontal/upward/short gestures, mobile/desktop placement, empty lists and query/focus preservation. Run Go formatting, vet and tests plus nsh checks/tests. Record unavailable device checks.

## factory · 2026-11-10 02:29
Built commit: 7f9ba47c. Touch-mobile searches now live inside the scrolling lists and reveal using nsh pull-to-refresh without a spinner (44pt release threshold). Contacts retains a virtualized list even when empty/loading/error. Revealing does not autofocus; revealed/query state remains accessible through navigation and rotation. Header controls and desktop placement are preserved.
Decisions: Non-touch narrow desktop layouts keep inline search visible because no touch pull is available. A search accessibility action provides an alternate reveal. Android start-at-top detection relies on nsh drag-start delivery; verify on device. Documented the refreshing-state reset required to avoid a retained gap.
Installs: none.
Tests: Manager verified formatting, go vet ./..., go test ./..., nsh check, and the final full nsh suite (355 passed, 0 failed). Initial manager shell timed out during the UI suite; a fresh complete run passed. Coder also built the web bundle successfully and added 10 focused pull-search tests.
Not checked: No real device or emulator visual, touch-gesture, keyboard or screen-reader checks. Review mobile spacing, trigger feel, Android drag-start behavior and accessibility action on a device.
Moved new/ → review/. Not merged into master.
