---
branch: factory/FT64-console-desktop-search-outside-topbar
round: 1
---
# Move desktop Topics and Contacts search boxes out of the topbar

## factory · 2026-11-10 10:12
Owner request (verbatim):
> new ui fix: 桌面端的 topics 和 contacts 的 searchbox 和移动端一样，也不应该放到 topbar 里面。

Requirements:
- On desktop, place the Topics and Contacts search boxes outside the topbar, in the corresponding list area, consistent with the mobile layout.
- Keep topbar actions and existing search/filter behavior intact; do not introduce duplicate search boxes.
- Preserve the mobile layout and coordinate spacing with FT60 (add top spacing and remove an equal amount of bottom spacing).
- Verify both lists at desktop and mobile widths, including responsive transitions.

Registered only; implementation and verification are pending.

## factory · plan · 2026-11-10 15:07
Behaviour: Desktop displays one search at the head of each scrolling list, outside the topbar. Filtering, clear and Escape stay unchanged. Mobile retains pull-to-reveal. Search remains usable for loading, error and empty list states; responsive transitions preserve query without duplicates.
Scope: Topics and Contacts list layout, shared comments and regression tests only; no filtering redesign.
Decisions: Reuse IndexSearch and pull search. Avoid double desktop gutters. Preserve shared spacing so FT60's adjustment applies when merged. The existing globally empty Topics screen remains unchanged.
Checking: Cover placement, uniqueness, filtering, clear/Escape, empty/error/loading and responsive transitions. Run repository Go checks and console check/tests; compare desktop and mobile rendering.

## factory · 2026-11-10 15:07
Built and pushed 08e22874. Moved desktop Topics search into its scroll list and unified Contacts desktop/mobile list rendering, keeping search and error messages in the list header. Topbar actions and mobile pull search are preserved. Added regression coverage.
Decisions: Shared IndexSearch spacing is unchanged; FT60 is not merged yet and coder reports merge-tree compatibility. Contacts keeps focus across responsive changes. Desktop touch layouts retain the existing pull gesture infrastructure.
Installs: none.
Tests: gofmt check, go vet ./..., go test ./..., nsh check, and nsh test --web-host tests/noHost.js passed. Manager independently verified Go checks and console checks (409 passed, 0 failed). Initial manager console run was interrupted by tool timeout; detached rerun completed successfully.
UI: Coder compared Chrome before/after screenshots at desktop 1280, mobile 420, and touch 390 widths. Mobile remained pixel-identical; desktop searches scroll with lists. Loading/error/empty positions checked visually. Contacts loading was visually checked rather than in the new automated test because a never-answering request blocks the harness.
Not checked: native desktop app and real Android device/emulator.
Push initially required credential.useHttpPath=true; retry with command-local setting succeeded.
Move: new/ → review/.
