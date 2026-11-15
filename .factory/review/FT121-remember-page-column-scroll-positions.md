---
branch: factory/FT121-remember-page-column-scroll-positions
round: 1
---
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

## factory · plan · 2026-11-15 09:14
Behaviour: save each page's column 2 and column 3 scrolling areas in RAM when navigating away; restore the same selection once containers/content are ready, clamp safely, and start unsaved areas at the top. A changed column 2 selection resets column 3 rather than keeping per-item history. Preserve chat follow-latest behaviour.
Scope: shared nsh Scroll/List helper and wiring across navigation pages, both sidebar and bottom navigation; no dialogs, nested scrollers, persistence or selection changes.
Decisions: page/endpoint/column/area keys; last selection identity only for column 3; async readiness and bounded retries; chat uses message anchors for virtualized row measurement.
Checking: navigation away/back, independent pages/areas/endpoints, selection changes, delayed/short content, RAM lifetime, Go checks and Console checks/tests; browser inspection on desktop and phone layouts.

## factory · 2026-11-15 09:14
Built ddad4f86: shared scroll memory and integration across Topics, Contacts, TODO, Memories, Skills, Usage, Audit and Settings. Chat restores the visible message when scrolled up; follows latest when left at the end. Mobile slide completion re-applies restored offsets to handle silent browser resets. Added helper and real-page regression coverage and English documentation.
Decisions: in-memory module map only; column 3 keeps only the last selection; asynchronous restoration retries for about five seconds unless held by a ready flag. Pages that clear selection on leaving keep doing so. The Page wrapper gains only an optional memory pass-through prop to cover Usage.
Installs: none.
Verification: manager independently ran gofmt cleanliness, go vet ./... and go test ./... successfully; nsh check passed; required Console scripts/test.sh passed 113 files, 0 failed (192s). Coder also reported all checks passing, 14 helper tests and 5 real-page tests, and a warning-free web build.
Visual inspection: coder checked built web Console in Chrome at desktop and phone sizes with stubbed API; restored lists and conversation held through mobile transitions; no storage keys written and reload starts fresh.
Not checked: native GPUI desktop, physical Android device, Safari or Firefox. Silent browser-reset fix has no direct automated reproduction. Content arriving after the bounded retry window without a ready flag can settle at the reachable offset. Phone bottom-navigation integration specifically tested Topics and Contacts; other pages rely on helper coverage.
Moved new/ → review/ for independent review. Branch push initially lacked credential path; succeeded on the permitted retry using per-command credential.useHttpPath=true.
