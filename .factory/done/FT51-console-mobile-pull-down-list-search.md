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

## factory · review · 2026-11-10 02:47
head: 7f9ba47c9ba05d4c5ea90bb1135f786664039332
verdict: pass
notes:
- Codex reviewed all six changed files against origin/master (b0b7cc57); no verified P0–P3 findings.
- Validation passed: Go formatting, go vet ./..., go test ./... (162 packages passed, 19 without tests), nsh check, nsh test --web-host tests/noHost.js (355 passed, 0 failed), and git diff --check. Tests used an isolated HEAD copy and absolute throwaway HOME.
- Installs: none. No code changes or commits.
- Not checked: real device, emulator or browser interaction, full build, Android drag-start events, actual touch scrolling, refresh-gap dismissal, soft keyboard, visual layout and screen reader behavior. Headless tests do not establish these behaviors.
- Moved review/ → ready/. Owner should inspect the mobile interaction before shipping; not merged into master.

## factory · 2026-11-10 07:47
Merged into master: 5f43db33. Released with tag v0.3.91 at afcb097b; master and tag pushed atomically.
Combined validation passed: gofmt check, go vet ./..., go test ./..., nsh check, nsh test --web-host tests/noHost.js (364/364), nsh build, and git diff --check. Scripted tests used an absolute throwaway HOME. No unpinned installs. No linked issues or PRs to close.
Not verified: real-device Android/mobile keyboard, touch gestures, system font-size and final visual appearance; no APK packaging or release CI validation in this ship run.
Moved ready/ → done/.
