# Remember page column scroll positions during navigation

## factory · 2026-11-15 08:30
Owner request:
> Remember the scrolling position. When switching at the nav(sidebar or bottom nav), it would be good to remember the page's column 2's list and column 3's scrolling position, if there are scrolling areas in them. In ram memory.
> For column 3, if column 2 current item changes, reset it's scrolling position.

## Acceptance criteria
- When navigating between pages using the sidebar or bottom navigation, remember and restore each page's column 2 list scroll position and column 3 scroll position wherever those columns contain scrolling areas.
- Keep positions independently per page and per scrolling area; restoring one must not overwrite another.
- Keep this state in RAM only. Do not persist it to localStorage, sessionStorage, a database, or the server; a full reload starts fresh.
- Returning to the same selected column 2 item restores column 3's previous position. Changing the current item in column 2 resets the corresponding column 3 scrolling area(s) to the top, rather than restoring the previous item's position.
- A page or scrolling area without a saved position starts at the top. Handle pages without scrollable column 2 or column 3 safely.
- Restore after the target content and scroll containers are ready so rendering does not immediately overwrite the restored position; clamp safely if the content is shorter.
- Apply consistently to desktop sidebar navigation and mobile bottom navigation without changing selection behavior.
- Add regression coverage for navigating away and back, independent page/column positions, column 3 reset on selection changes, and RAM-only state lifetime.
